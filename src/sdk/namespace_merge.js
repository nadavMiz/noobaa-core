/* Copyright (C) 2016 NooBaa */
'use strict';

// const _ = require('lodash');
const P = require('../util/promise');
const _ = require('lodash');
const S3Error = require('../endpoint/s3/s3_errors').S3Error;

const EXCEPT_REASONS = [
    'NO_SUCH_OBJECT'
];

/**
 * @implements {nb.Namespace}
 */
class NamespaceMerge {

    constructor({ namespaces, active_triggers }) {
        this.namespaces = namespaces;
        this.active_triggers = active_triggers;
    }

    get_write_resource() {
        return this.namespaces.write_resource;
    }

    is_server_side_copy(other, other_md, params) {
        // we do not allow server side copy for merge
        return false;
    }

    get_bucket(bucket) {
        return bucket;
    }

    is_readonly_namespace() {
        if (_.isUndefined(this.namespaces.write_resource)) return true;
        return this.namespaces.write_resource.is_readonly_namespace();
    }

    /////////////////
    // OBJECT LIST //
    /////////////////

    async list_objects(params, object_sdk) {
        return this._ns_map(ns => ns.list_objects(params, object_sdk), ['NoSuchBucket', 'ContainerNotFound'], this.cast_err_to_s3err)
            .then(res => this._handle_list(res, params));
    }

    list_uploads(params, object_sdk) {
        return this._ns_map(ns => ns.list_uploads(params, object_sdk), ['NoSuchBucket', 'ContainerNotFound'], this.cast_err_to_s3err)
            .then(res => this._handle_list(res, params));
    }

    list_object_versions(params, object_sdk) {
        return this._ns_map(ns => ns.list_object_versions(params, object_sdk), ['NoSuchBucket', 'ContainerNotFound'], this.cast_err_to_s3err)
            .then(res => this._handle_list(res, params));
    }

    /////////////////
    // OBJECT READ //
    /////////////////

    read_object_md(params, object_sdk) {
        return this._ns_map(ns => ns.read_object_md(params, object_sdk)
                .then(res => {
                    // save the ns in the response for optimizing read_object_stream
                    res.ns = res.ns || ns;
                    return res;
                }), EXCEPT_REASONS)
            .then(reply => {
                const working_set = _.sortBy(
                    reply,
                    'create_time'
                );
                return _.last(working_set);
            });
    }

    async read_object_stream(params, object_sdk) {
        params = _.omit(params, 'noobaa_trigger_agent');
        let reply;
        // use the saved ns from read_object_md
        if (params.object_md && params.object_md.ns) {
            reply = params.object_md.ns.read_object_stream(params, object_sdk);
        } else {
            reply = this._ns_get(ns => ns.read_object_stream(params, object_sdk));
        }
        return reply;
    }

    ///////////////////
    // OBJECT UPLOAD //
    ///////////////////

    async upload_object(params, object_sdk) {
        const reply = await this._ns_put(ns => ns.upload_object(params, object_sdk));
        return reply;
    }

    upload_blob_block(params, object_sdk) {
        return this._ns_put(ns => ns.upload_blob_block(params, object_sdk));
    }

    commit_blob_block_list(params, object_sdk) {
        return this._ns_put(ns => ns.commit_blob_block_list(params, object_sdk));
    }

    get_blob_block_lists(params, object_sdk) {
        // TODO: should we get blob block lists from read resources as well?
        return this._ns_put(ns => ns.get_blob_block_lists(params, object_sdk));
    }


    /////////////////////////////
    // OBJECT MULTIPART UPLOAD //
    /////////////////////////////

    create_object_upload(params, object_sdk) {
        return this._ns_put(ns => ns.create_object_upload(params, object_sdk));
    }

    upload_multipart(params, object_sdk) {
        return this._ns_put(ns => ns.upload_multipart(params, object_sdk));
    }

    list_multiparts(params, object_sdk) {
        return this._ns_put(ns => ns.list_multiparts(params, object_sdk));
    }

    async complete_object_upload(params, object_sdk) {
        const reply = await this._ns_put(ns => ns.complete_object_upload(params, object_sdk));
        return reply;
    }

    abort_object_upload(params, object_sdk) {
        return this._ns_put(ns => ns.abort_object_upload(params, object_sdk));
    }

    ///////////////////
    // OBJECT DELETE //
    ///////////////////

    // TODO should we: (1) delete from all ns ? (2) delete from writable ns ? (3) create a "delete marker" on writable ns

    async delete_object(params, object_sdk) {
        const reply = await this._ns_map(ns => ns.delete_object(params, object_sdk), EXCEPT_REASONS);
        // TODO: Decide which one to return (currently we do not support versioning on our namespaces)
        return _.first(reply);
    }


    async delete_multiple_objects(params, object_sdk) {
        const deleted_res = await this._ns_map(ns => ns.delete_multiple_objects(params, object_sdk));
        const merged_res = this._merge_multiple_delete_responses({
            deleted_res,
            total_objects: params.objects.length
        });
        return _.map(merged_res, obj => obj.res);
    }


    _merge_multiple_delete_responses(params) {
        const { deleted_res } = params;
        let ns_conslusion;
        for (let ns = 0; ns < deleted_res.length; ++ns) {
            const deleted_ns = deleted_res[ns];
            const ns_merged = this._handle_single_namespace_deletes({ deleted_ns });
            if (ns_conslusion) {
                for (let obj_index = 0; obj_index < ns_conslusion.length; obj_index++) {
                    ns_conslusion[obj_index] =
                        this._pick_ns_obj_reply({ curr: ns_conslusion[obj_index], cand: ns_merged[obj_index] });
                }
            } else {
                ns_conslusion = ns_merged;
            }
        }

        return ns_conslusion;
    }


    _handle_single_namespace_deletes(params) {
        const response = [];
        const { deleted_ns } = params;
        for (let i = 0; i < deleted_ns.length; ++i) {
            const res = deleted_ns[i];
            if (_.isUndefined(res && res.err_code)) {
                response.push({ success: true, res });
            } else {
                response.push({ success: false, res });
            }
        }
        return response;
    }


    _pick_ns_obj_reply(params) {
        const { curr, cand } = params;
        const STATUSES = {
            FAILED_WITHOUT_INFO: 1,
            SUCCEEDED_WITHOUT_INFO: 0
        };
        const get_object_status = object => {
            if (object.success) return STATUSES.SUCCEEDED_WITHOUT_INFO;
            return STATUSES.FAILED_WITHOUT_INFO;
        };
        const curr_status = get_object_status(curr);
        const cand_status = get_object_status(cand);

        if (curr_status > cand_status) return curr;
        if (cand_status > curr_status) return cand;
        return curr;
    }


    ////////////////////
    // OBJECT TAGGING //
    ////////////////////

    get_object_tagging(params, object_sdk) {
        return this._ns_get(ns => ns.get_object_tagging(params, object_sdk));
    }

    delete_object_tagging(params, object_sdk) {
        return this._ns_put(ns => ns.delete_object_tagging(params, object_sdk));
    }

    put_object_tagging(params, object_sdk) {
        return this._ns_put(ns => ns.put_object_tagging(params, object_sdk));
    }

    //////////
    // ACLs //
    //////////

    get_object_acl(params, object_sdk) {
        return this._ns_get(ns => ns.get_object_acl(params, object_sdk));
    }

    put_object_acl(params, object_sdk) {
        return this._ns_put(ns => ns.put_object_acl(params, object_sdk));
    }

    ///////////////////
    //  OBJECT LOCK  //
    ///////////////////

    async get_object_legal_hold() {
        throw new Error('TODO');
    }
    async put_object_legal_hold() {
        throw new Error('TODO');
    }
    async get_object_retention() {
        throw new Error('TODO');
    }
    async put_object_retention() {
        throw new Error('TODO');
    }

    ////////////////////
    // OBJECT RESTORE //
    ////////////////////

    async restore_object(params, object_sdk) {
        // Instead of iterating over the namespaces, directly throw the error for now
        throw new S3Error(S3Error.NotImplemented);
    }

    //////////////
    // INTERNAL //
    //////////////

    /**
     * @param {(ns:nb.Namespace) => Promise} func
     */
    async _ns_get(func) {
        for (const ns of this.namespaces.read_resources) {
            try {
                const res = await func(ns);
                return res;
            } catch (err) {
                continue;
            }
        }
        throw new Error('NamespaceMerge._ns_get exhausted');
    }

    /**
     * @param {(ns:nb.Namespace) => Promise} func
     */
    async _ns_put(func) {
        const ns = this.namespaces.write_resource;
        const res = await func(ns);
        return res;
    }

    /**
     * @param {(ns:nb.Namespace) => Promise} func
     */
    async _ns_map(func, except_reasons, cast_error_func = null) {
        const replies = await P.map(this.namespaces.read_resources, async ns => {
            try {
                const res = await func(ns);
                return { reply: res, success: true };
            } catch (err) {
                return {
                    error: cast_error_func ? cast_error_func(err) : err,
                    success: false
                };
            }
        });
        return this._throw_if_any_failed_or_get_succeeded(replies, except_reasons);
    }

    _get_succeeded_responses(reply_array) {
        return reply_array.filter(res => res.success).map(rec => rec.reply);
    }

    _get_failed_responses(reply_array, except_reasons) {
        return reply_array.filter(
                res => !res.success &&
                !_.includes(except_reasons || [], res.error.rpc_code || res.error.code || 'UNKNOWN_ERR')
            )
            .map(rec => rec.error);
    }

    // _throw_if_all_failed_or_get_succeeded(reply_array, except_reasons) {
    //     const succeeded = this._get_succeeded_responses(reply_array);
    //     if (!_.isEmpty(succeeded)) return succeeded;
    //     const failed = this._get_failed_responses(reply_array, except_reasons);
    //     throw _.first(failed);
    // }

    _throw_if_any_failed_or_get_succeeded(reply_array, except_reasons) {
        const failed = this._get_failed_responses(reply_array, except_reasons);
        if (!_.isEmpty(failed)) throw _.first(failed);
        const succeeded = this._get_succeeded_responses(reply_array);
        // Since we did not have any success and all of the errors were except_reasons we rely on the first error.
        if (_.isEmpty(succeeded)) throw _.first(reply_array).error;
        return succeeded;
    }

    // TODO: Currently it only takes the most recent objects without duplicates
    // This means that in list_object_versions we will only see the is_latest objects
    // Which is not what we wanted since we want to see all of the versions
    _handle_list(res, params) {
        if (res.length === 1) return res[0];
        let i;
        let j;
        const map = {};
        let is_truncated;
        for (i = 0; i < res.length; ++i) {
            for (j = 0; j < res[i].objects.length; ++j) {
                const obj = res[i].objects[j];
                if (!map[obj.key] ||
                    (map[obj.key] && obj.create_time > map[obj.key].create_time)
                ) map[obj.key] = obj;
            }
            for (j = 0; j < res[i].common_prefixes.length; ++j) {
                const prefix = res[i].common_prefixes[j];
                map[prefix] = prefix;
            }
            if (res[i].is_truncated) is_truncated = true;
        }
        const all_names = Object.keys(map);
        all_names.sort();
        const names = all_names.slice(0, params.limit || 1000);
        const objects = [];
        const common_prefixes = [];
        for (i = 0; i < names.length; ++i) {
            const name = names[i];
            const obj_or_prefix = map[name];
            if (typeof obj_or_prefix === 'string') {
                common_prefixes.push(obj_or_prefix);
            } else {
                objects.push(obj_or_prefix);
            }
        }
        if (names.length < all_names.length) {
            is_truncated = true;
        }
        // TODO picking the name as marker is not according to spec of both S3 and Azure
        // because the marker is opaque to the client and therefore it is not safe to assume that using this as next marker
        // will really provide a stable iteration.
        const next_marker = is_truncated ? names[names.length - 1] : undefined;
        // In case of prefix there will be no object (which means undefined)
        const last_obj_or_prefix = map[names[names.length - 1]];
        const next_version_id_marker =
            is_truncated && (typeof last_obj_or_prefix === 'object') ?
            last_obj_or_prefix.version_id : undefined;
        const next_upload_id_marker =
            is_truncated && (typeof last_obj_or_prefix === 'object') ?
            last_obj_or_prefix.obj_id : undefined;

        return {
            objects,
            common_prefixes,
            is_truncated,
            next_marker,
            next_version_id_marker,
            next_upload_id_marker
        };
    }
    cast_err_to_s3err(err) {
        if (!err) return;
        const err_to_s3err_map = {
            'NoSuchBucket': S3Error.NoSuchBucket,
            'ContainerNotFound': S3Error.NoSuchBucket,
        };
        const exist = err_to_s3err_map[err.code];
        if (!exist) return err;
        const s3error = new S3Error(exist);
        s3error.message = err.message;
        return s3error;
    }
}


module.exports = NamespaceMerge;
