'use strict';

let _ = require('lodash');
let P = require('../../util/promise');
let db = require('../db');
let map_utils = require('./map_utils');
let block_allocator = require('./block_allocator');
let md_store = require('../stores/md_store');
let system_store = require('../stores/system_store');
let server_rpc = require('../server_rpc');
let mongo_utils = require('../../util/mongo_utils');
let js_utils = require('../../util/js_utils');
// let promise_utils = require('../../util/promise_utils');
let config = require('../../../config.js');
let Semaphore = require('../../util/semaphore');
let dbg = require('../../util/debug_module')(__filename);

let replicate_block_sem = new Semaphore(config.REPLICATE_CONCURRENCY);


/**
 *
 * MapBuilder
 *
 * process list of chunk in a batch, and for each one make sure they are well built,
 * meaning that their blocks are available, by creating new blocks and replicating
 * them from accessible blocks, and removing unneeded blocks.
 *
 */
class MapBuilder {

    constructor(chunks) {
        this.chunks = chunks;
    }

    run() {
        dbg.log1('MapBuilder.run:', 'batch start', this.chunks.length, 'chunks');
        return P.resolve()
            .then(() => P.join(
                system_store.refresh(),
                md_store.load_blocks_for_chunks(this.chunks),
                this.mark_building()
            ))
            .then(() => this.analyze_chunks())
            .then(() => this.refresh_alloc())
            .then(() => this.allocate_blocks())
            .then(() => this.replicate_blocks())
            .then(() => this.update_db())
            .then(() => {
                // return error from the promise if any replication failed,
                // so that caller will know the build isn't really complete,
                // although it might partially succeeded
                if (this.had_errors) {
                    throw new Error('MapBuilder had errors');
                }
            });
    }


    // update the chunks to building mode
    mark_building() {
        let chunks_need_update_to_building = _.reject(this.chunks, 'building');
        return chunks_need_update_to_building.length &&
            P.when(db.DataChunk.collection.updateMany({
                _id: {
                    $in: _.map(chunks_need_update_to_building, '_id')
                }
            }, {
                $set: {
                    building: new Date(),
                }
            }));
    }

    analyze_chunks() {
        _.each(this.chunks, chunk => {
            let bucket = system_store.data.get_by_id(chunk.bucket);
            map_utils.set_chunk_frags_from_blocks(chunk, chunk.blocks);
            chunk.status = map_utils.get_chunk_status(chunk, bucket.tiering, /*ignore_cloud_pools=*/ false);
            // only delete blocks if the chunk is in good shape,
            // that is no allocations needed, and is accessible.
            if (chunk.status.accessible &&
                !chunk.status.allocations.length &&
                chunk.status.deletions.length) {
                this.delete_blocks = this.delete_blocks || [];
                js_utils.array_push_all(this.delete_blocks, chunk.status.deletions);
            }
        });
    }

    refresh_alloc() {
        let bucket_ids = mongo_utils.uniq_ids(this.chunks, 'bucket');
        let buckets = _.map(bucket_ids, id => system_store.data.get_by_id(id));
        return P.map(buckets,
            bucket => block_allocator.refresh_tiering_alloc(bucket.tiering)
        );
    }

    allocate_blocks() {
        _.each(this.chunks, chunk => {
            let avoid_nodes = _.map(chunk.blocks, block => block.node._id.toString());
            _.each(chunk.status.allocations, alloc => {
                let f = alloc.fragment;
                let block = _.pick(f,
                    'layer',
                    'layer_n',
                    'frag',
                    'size',
                    'digest_type',
                    'digest_b64');
                block._id = md_store.make_md_id();
                let node = block_allocator.allocate_node(alloc.pools, avoid_nodes);
                if (!node) {
                    dbg.error('MapBuilder: no nodes for allocation');
                    chunk.had_errors = true;
                    this.had_errors = true;
                    return;
                }
                block.node = node;
                block.system = chunk.system;
                block.chunk = chunk;
                alloc.block = block;
                this.new_blocks = this.new_blocks || [];
                this.new_blocks.push(block);
                avoid_nodes.push(node._id.toString());
            });
        });
    }

    replicate_blocks() {
        const now = Date.now();
        return P.all(_.map(this.chunks, chunk => {
            return P.all(_.map(chunk.status.allocations, alloc => {
                let block = alloc.block;
                if (!block) {
                    // block that failed to allocate - skip replicate.
                    return;
                }

                let f = alloc.fragment;
                f.accessible_blocks = f.accessible_blocks ||
                    _.filter(f.blocks, block => map_utils.is_block_accessible(block, now));
                f.next_source = f.next_source || 0;
                let source_block = f.accessible_blocks[f.next_source];
                f.next_source = (f.next_source + 1) % f.accessible_blocks.length;

                let target = map_utils.get_block_md(block);
                let source = map_utils.get_block_md(source_block);

                dbg.log1('MapBuilder.replicate_blocks: replicating to', target,
                    'from', source, 'chunk', chunk);
                return replicate_block_sem.surround(() => {
                    return server_rpc.client.agent.replicate_block({
                        target: target,
                        source: source
                    }, {
                        address: target.address,
                    });
                }).then(() => {
                    dbg.log1('MapBuilder.replicate_blocks: replicated block',
                        block._id, 'to', target.address, 'from', source.address);
                }, err => {
                    dbg.error('MapBuilder.replicate_blocks: FAILED replicate block',
                        block._id, 'to', target.address, 'from', source.address,
                        err.stack || err);
                    chunk.had_errors = true;
                    this.had_errors = true;
                    // don't fail here yet to allow handling the successful blocks
                    // so just keep the error, and we will fail at the end of build_chunks
                });
            }));
        }));
    }

    update_db() {
        _.each(this.new_blocks, block => {
            block.node = block.node._id;
            block.chunk = block.chunk._id;
        });
        let success_chunk_ids = mongo_utils.uniq_ids(
            _.reject(this.chunks, 'had_errors'), '_id');
        let failed_chunk_ids = mongo_utils.uniq_ids(
            _.filter(this.chunks, 'had_errors'), '_id');

        dbg.log1('MapBuilder.update_db:',
            'chunks', this.chunks.length,
            'success_chunk_ids', success_chunk_ids.length,
            'failed_chunk_ids', failed_chunk_ids.length,
            'new_blocks', this.new_blocks && this.new_blocks.length || 0,
            'delete_blocks', this.delete_blocks && this.delete_blocks.length || 0);

        return P.join(
            this.new_blocks && this.new_blocks.length &&
            P.when(db.DataBlock.collection.insertMany(this.new_blocks)),

            this.delete_blocks && this.delete_blocks.length &&
            P.when(db.DataBlock.collection.updateMany({
                _id: {
                    $in: mongo_utils.uniq_ids(this.delete_blocks, '_id')
                }
            }, {
                $set: {
                    deleted: new Date()
                }
            })),

            success_chunk_ids.length &&
            db.DataChunk.collection.updateMany({
                _id: {
                    $in: success_chunk_ids
                }
            }, {
                $set: {
                    last_build: new Date(),
                },
                $unset: {
                    building: true
                }
            }),

            failed_chunk_ids.length &&
            db.DataChunk.collection.updateMany({
                _id: {
                    $in: failed_chunk_ids
                }
            }, {
                $unset: {
                    building: true
                }
            })
        );
    }
}


module.exports = MapBuilder;