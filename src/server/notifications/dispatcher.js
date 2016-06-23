'use strict';

const _ = require('lodash');
var native_core = require('../../native_core')();
const ActivityLog = require('../analytic_services/activity_log');
const system_store = require('../system_services/system_store');
const nodes_store = require('../node_services/nodes_store');
const md_store = require('../object_services/md_store');
const P = require('../../util/promise');
const mongo_utils = require('../../util/mongo_utils');
const dbg = require('../../util/debug_module')(__filename);

var NotificationTypes = Object.freeze({
    ALERT: 1,
    NOTIFICATION: 2,
    ACTIVITYLOG: 3,
});

class Dispatcher {

    static get_instance() {
        Dispatcher._dispatcher = Dispatcher._dispatcher || new Dispatcher();
        return Dispatcher._dispatcher;
    }

    constructor() {
        this._ext_syslog = new native_core.Syslog();
        this._pid = process.pid;
    }

    activity(item) {
        var formatted = this._format_activity_log(item);
        dbg.log0('Adding ActivityLog entry', formatted);
        ActivityLog.create(formatted);
    }

    read_activity_log(req) {
        var q = ActivityLog.find({
            system: req.system._id,
        });

        var reverse = true;
        if (req.rpc_params.till) {
            // query backwards from given time
            req.rpc_params.till = new Date(req.rpc_params.till);
            q.where('time').lt(req.rpc_params.till).sort('-time');

        } else if (req.rpc_params.since) {
            // query forward from given time
            req.rpc_params.since = new Date(req.rpc_params.since);
            q.where('time').gte(req.rpc_params.since).sort('time');
            reverse = false;
        } else {
            // query backward from last time
            q.sort('-time');
        }
        if (req.rpc_params.event) {
            q.where({
                event: new RegExp(req.rpc_params.event)
            });
        }
        if (req.rpc_params.events) {
            q.where('event').in(req.rpc_params.events);
        }
        if (req.rpc_params.csv) {
            //limit to million lines just in case (probably ~100MB of text)
            q.limit(1000000);
        } else {
            if (req.rpc_params.skip) q.skip(req.rpc_params.skip);
            q.limit(req.rpc_params.limit || 10);
        }

        return P.resolve(q.lean().exec())
            .then(logs => P.join(
                nodes_store.instance().populate_nodes_fields(logs, 'node', {
                    name: 1
                }),
                mongo_utils.populate(logs, 'obj', md_store.ObjectMD.collection, {
                    key: 1
                })).return(logs))
            .then(logs => {
                logs = _.map(logs, function(log_item) {
                    var l = {
                        id: String(log_item._id),
                        level: log_item.level,
                        event: log_item.event,
                        time: log_item.time.getTime(),
                    };

                    let tier = log_item.tier && system_store.data.get_by_id(log_item.tier);
                    if (tier) {
                        l.tier = _.pick(tier, 'name');
                    }

                    if (log_item.node) {
                        l.node = _.pick(log_item.node, 'name');
                    }

                    if (log_item.desc) {
                        l.desc = log_item.desc.split('\n');
                    }

                    let bucket = log_item.bucket && system_store.data.get_by_id(log_item.bucket);
                    if (bucket) {
                        l.bucket = _.pick(bucket, 'name');
                    }

                    let pool = log_item.pool && system_store.data.get_by_id(log_item.pool);
                    if (pool) {
                        l.pool = _.pick(pool, 'name');
                    }

                    if (log_item.obj) {
                        l.obj = _.pick(log_item.obj, 'key');
                    }

                    let account = log_item.account && system_store.data.get_by_id(log_item.account);
                    if (account) {
                        l.account = _.pick(account, 'email');
                    }

                    let actor = log_item.actor && system_store.data.get_by_id(log_item.actor);
                    if (actor) {
                        l.actor = _.pick(actor, 'email');
                    }

                    return l;
                });
                if (reverse) {
                    logs.reverse();
                }
                return {
                    logs: logs
                };
            });
    }

    _format_activity_log(item) {
        return item;
    }

    send_syslog(item) {
        dbg.log0('Sending external syslog', item);
        this._ext_syslog.log(5 /*INFO*/ , item.description);
    }

}

// EXPORTS
exports.Dispatcher = Dispatcher;
exports.get_instance = Dispatcher.get_instance;
exports.NotificationTypes = NotificationTypes;
