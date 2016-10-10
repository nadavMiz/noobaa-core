/**
 *
 * AGENT
 *
 * the glorious noobaa agent.
 *
 */
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const ip_module = require('ip');
const express_compress = require('compression');
const express_body_parser = require('body-parser');
const express_morgan_logger = require('morgan');
const express_method_override = require('method-override');

const P = require('../util/promise');
const pem = require('../util/pem');
const api = require('../api');
const pkg = require('../../package.json');
const dbg = require('../util/debug_module')(__filename);
const diag = require('./agent_diagnostics');
const config = require('../../config');
const os_utils = require('../util/os_utils');
const js_utils = require('../util/js_utils');
const RpcError = require('../rpc/rpc_error');
const url_utils = require('../util/url_utils');
const size_utils = require('../util/size_utils');
const time_utils = require('../util/time_utils');
const BlockStoreFs = require('./block_store_fs').BlockStoreFs;
const BlockStoreS3 = require('./block_store_s3').BlockStoreS3;
const BlockStoreMem = require('./block_store_mem').BlockStoreMem;
const BlockStoreAzure = require('./block_store_azure').BlockStoreAzure;
const promise_utils = require('../util/promise_utils');
const cloud_utils = require('../util/cloud_utils');


const MASTER_RESPONSE_TIMEOUT = 30 * 1000; // 30 timeout for master to respond to HB
const MASTER_MAX_CONNECT_ATTEMPTS = 20;

class Agent {

    constructor(params) {
        dbg.log0('process.env.DEBUG_MODE=' + process.env.DEBUG_MODE);

        this.rpc = api.new_rpc(params.address);
        this.client = this.rpc.new_client();

        this.servers = params.servers || [{
            address: params.address
        }];

        this.host_id = params.host_id;

        assert(params.node_name, 'missing param: node_name');
        this.node_name = params.node_name;
        this.token = params.token;
        this.storage_path = params.storage_path;
        if (params.storage_limit) {
            this.storage_limit = params.storage_limit;
        }

        this.is_demo_agent = params.is_demo_agent;

        const block_store_options = {
            node_name: this.node_name,
            rpc_client: this.client,
            storage_limit: params.storage_limit,
        };
        if (this.storage_path) {
            assert(!this.token, 'unexpected param: token. ' +
                'with storage_path the token is expected in the file <storage_path>/token');
            if (params.cloud_info) {
                this.cloud_info = params.cloud_info;
                block_store_options.cloud_info = params.cloud_info;
                if (params.cloud_info.endpoint_type === 'AWS' || params.cloud_info.endpoint_type === 'S3_COMPATIBLE') {
                    this.block_store = new BlockStoreS3(block_store_options);
                } else if (params.cloud_info.endpoint_type === 'AZURE') {
                    let connection_string = cloud_utils.get_azure_connection_string({
                        endpoint: params.cloud_info.endpoint,
                        access_key: params.cloud_info.access_keys.access_key,
                        secret_key: params.cloud_info.access_keys.secret_key
                    });
                    block_store_options.cloud_info.azure = {
                        connection_string: connection_string,
                        container: params.cloud_info.target_bucket
                    };
                    this.block_store = new BlockStoreAzure(block_store_options);
                }
            } else {
                block_store_options.root_path = this.storage_path;
                this.block_store = new BlockStoreFs(block_store_options);
            }
        } else {
            assert(this.token, 'missing param: token. ' +
                'without storage_path the token must be provided as agent param');
            this.block_store = new BlockStoreMem(block_store_options);
        }

        this.agent_app = (() => {
            const app = express();
            app.use(express_morgan_logger('dev'));
            app.use(express_body_parser.json());
            app.use(express_body_parser.raw({
                // increase size limit on raw requests to allow serving data blocks
                limit: 4 * size_utils.MEGABYTE
            }));
            app.use(express_body_parser.text());
            app.use(express_body_parser.urlencoded({
                extended: false
            }));
            app.use(express_method_override());
            app.use(express_compress());
            return app;
        })();

        // AGENT API methods - bind to self
        // (rpc registration requires bound functions)
        js_utils.self_bind(this, [
            'get_agent_info_and_update_masters',
            'update_auth_token',
            'update_rpc_config',
            'n2n_signal',
            'test_store_perf',
            'test_network_perf',
            'test_network_perf_to_peer',
            'collect_diagnostics',
            'set_debug_node',
        ]);

        // register rpc to serve the apis
        this.rpc.register_service(
            this.rpc.schema.agent_api,
            this, {
                middleware: [req => this._authenticate_agent_api(req)]
            });
        this.rpc.register_service(
            this.rpc.schema.block_store_api,
            this.block_store, {
                // TODO verify requests for block store?
                // middleware: [ ... ]
            });
        // register rpc http server
        this.rpc.register_http_transport(this.agent_app);
        // register rpc n2n
        this.n2n_agent = this.rpc.register_n2n_agent(this.client.node.n2n_signal);

        // TODO these sample geolocations are just for testing
        this.geolocation = _.sample([
            // aws
            'North Virginia',
            'North California',
            'Oregon',
            'Ireland',
            'Frankfurt',
            'Singapore',
            'Sydney',
            'Tokyo',
            'Sao Paulo',
            // google cloud
            'Iowa',
            'Belgium',
            'Taiwan',
        ]);
    }

    start() {
        this.is_started = true;
        this.rpc.set_disconnected_state(false);

        return P.resolve()
            .then(() => this._init_node())
            .then(() => this._do_heartbeat())
            .catch(err => {
                dbg.error('server failed to start', err.stack || err);
                this.stop();
                throw err;
            });
    }

    stop() {
        dbg.log0('stop agent ' + this.node_name);
        this.is_started = false;
        // mark the rpc state as disconnected to close and reject incoming connections
        this.rpc.set_disconnected_state(true);
        this._start_stop_server();
        // reset the n2n config to close any open ports
        this.n2n_agent.update_n2n_config({
            tcp_permanent_passive: false
        });
    }

    _update_servers_list(new_list) {
        let sorted_new = _.sortBy(new_list, srv => srv.address);
        let sorted_old = _.sortBy(this.servers, srv => srv.address);
        if (_.isEqual(sorted_new, sorted_old)) return P.resolve();
        this.servers = new_list;
        return this._update_agent_conf({
            servers: this.servers
        });
    }

    _handle_server_change(suggested) {
        dbg.warn('_handle_server_change',
            suggested ?
            'suggested server ' + suggested :
            'no suggested server, trying next in list',
            this.servers);
        this.connect_attempts = 0;
        if (!this.servers.length) {
            dbg.error('_handle_server_change no server list');
            return P.resolve();
        }
        const previous_address = this.servers[0].address;
        dbg.log0('previous_address =', previous_address);
        dbg.log0('original servers list =', this.servers);
        if (suggested) {
            //Find if the suggested server appears in the list we got from the initial connect
            const current_server = _.remove(this.servers, function(srv) {
                return srv.address === suggested;
            });
            if (current_server[0]) {
                this.servers.unshift(current_server[0]);
            } else {
                this.servers.push(this.servers.shift());
            }
        } else {
            //Skip to the next server in list
            this.servers.push(this.servers.shift());
        }
        dbg.log0('new servers list =', this.servers);
        dbg.log('Chosen new address', this.servers[0].address, this.servers);
        return this._update_rpc_config_internal({
            base_address: this.servers[0].address,
            old_base_address: previous_address,
        });
    }

    _init_node() {
        return P.resolve()
            .then(() => {
                if (this.storage_path) {
                    return os_utils.get_mount_of_path(this.storage_path);
                }
            })
            .then(storage_path_mount => {
                this.storage_path_mount = storage_path_mount;

                // if not using storage_path, a token should be provided
                if (!this.storage_path) return this.token;

                // load the token file
                const token_path = path.join(this.storage_path, 'token');
                return fs.readFileAsync(token_path);
            })
            .then(token => {
                // use the token as authorization (either 'create_node' or 'agent' role)
                this.client.options.auth_token = token.toString();

                // test the existing token against the server. if not valid throw error, and let the
                // agent_cli create new node.
                return promise_utils.retry(MASTER_MAX_CONNECT_ATTEMPTS, 1000, () => {
                        this.client.node.test_node_id({})
                            .timeout(MASTER_RESPONSE_TIMEOUT)
                            .catch(err => {
                                return this._handle_server_change()
                                    .then(() => {
                                        throw err;
                                    });
                            });
                    })
                    .then(valid_node => {
                        if (!valid_node) {
                            let err = new Error('INVALID_NODE');
                            err.DO_NOT_RETRY = true;
                            throw err;
                        }
                    });
            })
            .then(() => P.fromCallback(callback => pem.createCertificate({
                days: 365 * 100,
                selfSigned: true
            }, callback)))
            .then(pem_cert => {
                this.ssl_cert = {
                    key: pem_cert.serviceKey,
                    cert: pem_cert.certificate
                };
                // update the n2n ssl to use my certificate
                this.n2n_agent.set_ssl_context(this.ssl_cert);
            })
            .then(() => this.block_store.init());
    }

    _do_heartbeat() {
        if (!this.is_started) return;

        if (this.connect_attempts > MASTER_MAX_CONNECT_ATTEMPTS) {
            dbg.error('too many failure to connect, switching servers');
            return this._handle_server_change();
        }

        let hb_info = {
            version: pkg.version
        };
        if (this.cloud_info) {
            hb_info.pool_name = this.cloud_info.cloud_pool_name;
        } else if (this.is_demo_agent) {
            hb_info.pool_name = config.DEMO_DEFAULTS.POOL_NAME;
        }
        return this.client.node.heartbeat(hb_info, {
                return_rpc_req: true
            })
            .timeout(MASTER_RESPONSE_TIMEOUT)
            .then(req => {
                this.connect_attempts = 0;
                const res = req.reply;
                const conn = req.connection;
                this._server_connection = conn;
                if (res.redirect) {
                    dbg.log0('got redirect response:', res.redirect);
                    return this._handle_server_change(res.redirect)
                        .then(() => {
                            throw new Error('redirect to ' + res.redirect);
                        });
                }
                if (res.version !== pkg.version) {
                    dbg.warn('exit on version change:',
                        'res.version', res.version,
                        'pkg.version', pkg.version);
                    process.exit(0);
                }
                conn.on('close', () => {
                    if (this._server_connection === conn) {
                        this._server_connection = null;
                    }
                    P.delay(1000).then(() => this._do_heartbeat());
                });
            })
            .catch(err => {
                dbg.error('heartbeat failed', err);
                if (err.rpc_code === 'DUPLICATE') {
                    dbg.error('This agent appears to be duplicated.',
                        'exiting and starting new agent', err);
                    process.exit(68); // 68 is 'D' in ascii
                }
                if (err.rpc_code === 'NODE_NOT_FOUND') {
                    // we want to reuse the agent_cli INVALID_NODE handling,
                    // but the fastest way to get there is restart the process,
                    // maybe better to reuse the code path instead.
                    dbg.error('This agent appears to be using an old token.',
                        'restarting to handle invalid node', err);
                    process.exit(0);
                }
                return P.delay(3000).then(() => {
                    this.connect_attempts += 1;
                    this._do_heartbeat();
                });

            });
    }

    _start_stop_server() {

        // in any case we stop
        this.n2n_agent.reset_rpc_address();
        if (this.server) {
            this.server.close();
            this.server = null;
        }

        if (!this.is_started) return;
        if (!this.rpc_address) return;

        const retry = () => {
            if (this.is_started) {
                setTimeout(() => this._start_stop_server(), 1000);
            }
        };

        const addr_url = url_utils.quick_parse(this.rpc_address);
        if (addr_url.protocol === 'n2n:') {
            this.n2n_agent.set_rpc_address(addr_url.href);
        } else if (addr_url.protocol === 'ws:' || addr_url.protocol === 'http:') {
            const http_server = http.createServer(this.agent_app)
                .on('error', err => {
                    dbg.error('AGENT HTTP SERVER ERROR', err.stack || err);
                    http_server.close();
                })
                .on('close', () => {
                    dbg.warn('AGENT HTTP SERVER CLOSED');
                    retry();
                })
                .listen(addr_url.port);
            if (addr_url.protocol === 'ws:') {
                this.rpc.register_ws_transport(http_server);
            }
            this.server = http_server;
        } else if (addr_url.protocol === 'wss:' || addr_url.protocol === 'https:') {
            const https_server = https.createServer(this.ssl_cert, this.agent_app)
                .on('error', err => {
                    dbg.error('AGENT HTTPS SERVER ERROR', err.stack || err);
                    https_server.close();
                })
                .on('close', () => {
                    dbg.warn('AGENT HTTPS SERVER CLOSED');
                    retry();
                })
                .listen(addr_url.port);
            if (addr_url.protocol === 'wss:') {
                this.rpc.register_ws_transport(https_server);
            }
            this.server = https_server;
        } else if (addr_url.protocol === 'tcp:') {
            const tcp_server = this.rpc.register_tcp_transport(addr_url.port);
            tcp_server.on('close', () => {
                dbg.warn('AGENT TCP SERVER CLOSED');
                retry();
            });
            this.server = tcp_server;
        } else if (addr_url.protocol === 'tls:') {
            const tls_server = this.rpc.register_tcp_transport(addr_url.port, this.ssl_cert);
            tls_server.on('close', () => {
                dbg.warn('AGENT TLS SERVER CLOSED');
                retry();
            });
            this.server = tls_server;
        } else {
            dbg.error('UNSUPPORTED AGENT PROTOCOL', addr_url);
        }
    }

    _authenticate_agent_api(req) {
        // agent_api request on the server connection are always allowed
        if (req.connection === this._server_connection) return;

        const auth = req.method_api.auth;
        if (!auth || !auth.n2n) {
            dbg.error('AGENT API requests only allowed from server',
                req.connection && req.connection.connid,
                this._server_connection && this._server_connection.connid);
            throw new RpcError('FORBIDDEN', 'AGENT API requests only allowed from server');
        }

        if (req.connection.url.protocol !== 'n2n:') {
            dbg.error('AGENT API auth requires n2n connection',
                req.connection && req.connection.connid);
            throw new RpcError('FORBIDDEN', 'AGENT API auth requires n2n connection');
        }
        // otherwise it's good
    }
    _update_agent_conf(params) {
        return fs.readFileAsync('agent_conf.json')
            .then(data => {
                const agent_conf = JSON.parse(data);
                dbg.log0('_update_agent_conf: old values in agent_conf.json:', agent_conf);
                return agent_conf;
            }, err => {
                if (err.code === 'ENOENT') {
                    dbg.log0('_update_agent_conf: no agent_conf.json file. creating new one...');
                    return {};
                } else {
                    throw err;
                }
            })
            .then(agent_conf => {
                _.assign(agent_conf, params);
                const data = JSON.stringify(agent_conf);
                dbg.log0('_update_agent_conf: writing new values to agent_conf.json:', agent_conf);
                return fs.writeFileAsync('agent_conf.json', data);
            });
    }

    _update_rpc_config_internal(params) {
        if (params.n2n_config) {
            this.n2n_agent.update_n2n_config(params.n2n_config);
        }

        if (params.rpc_address && params.rpc_address !== params.old_rpc_address) {
            dbg.log0('new rpc_address', params.rpc_address,
                'old', params.old_rpc_address);
            this.rpc_address = params.rpc_address;
            this._start_stop_server();
        }

        if (params.base_address && params.base_address !== params.old_base_address) {
            dbg.log0('new base_address', params.base_address,
                'old', params.old_base_address);
            // test this new address first by pinging it
            return P.fcall(() => this.client.node.ping(null, {
                    address: params.base_address
                }))
                // TODO: we need to handle the case when multiple agents (multidrive) try to update agent_conf
                .then(() => this._update_agent_conf({
                    address: params.base_address
                }))
                .then(() => {
                    dbg.log0('update_base_address: done -', params.base_address);
                    this.rpc.router = api.new_router(params.base_address);
                    // this.rpc.disconnect_all();
                    this._do_heartbeat();
                });
        }

        return P.resolve();
    }

    _fix_storage_limit(storage_info) {
        storage_info.limit = this.storage_limit;
        let limited_total = this.storage_limit;
        let limited_free = limited_total - storage_info.used;
        storage_info.total = Math.min(limited_total, storage_info.total);
        storage_info.free = Math.min(limited_free, storage_info.free);
    }

    // AGENT API //////////////////////////////////////////////////////////////////


    get_agent_info_and_update_masters(req) {
        const extended_hb = true;
        const ip = ip_module.address();
        dbg.log('Recieved potential servers list', req.rpc_params.addresses);
        const reply = {
            version: pkg.version || '',
            name: this.node_name || '',
            ip: ip,
            host_id: this.host_id,
            rpc_address: this.rpc_address || '',
            base_address: this.rpc.router.default,
            n2n_config: this.n2n_agent.get_plain_n2n_config(),
            geolocation: this.geolocation,
            debug_level: dbg.get_module_level('core'),
        };
        if (this.cloud_info && this.cloud_info.cloud_pool_name) {
            reply.cloud_pool_name = this.cloud_info.cloud_pool_name;
        }
        if (extended_hb) {
            reply.os_info = os_utils.os_info();
        }

        return this._update_servers_list(req.rpc_params.addresses)
            .then(() => this.block_store.get_storage_info())
            .then(storage_info => {
                dbg.log0('storage_info:', storage_info);
                reply.storage = storage_info;
                if (this.storage_limit) {
                    this._fix_storage_limit(reply.storage);
                    // reply.storage.limit = this.storage_limit;
                    // let limited_total = this.storage_limit;
                    // let limited_free = limited_total - reply.storage.used;
                    // reply.storage.total = Math.min(limited_total, reply.storage.total);
                    // reply.storage.free = Math.min(limited_free, reply.storage.free);
                }

            })
            .then(() => extended_hb && os_utils.read_drives()
                .catch(err => {
                    dbg.error('read_drives: ERROR', err.stack || err);
                }))
            .then(drives => {
                if (!drives) return;
                // for now we only use a single drive,
                // so mark the usage on the drive of our storage folder.
                const used_size = reply.storage.used;
                const used_drives = _.filter(drives, drive => {
                    dbg.log0('used drives:', this.storage_path_mount, drive, used_size);
                    //if there is no this.storage_path_mount, it's a memory agent for testing.
                    if (this.storage_path_mount === drive.mount || !this.storage_path_mount) {
                        drive.storage.used = used_size;
                        if (this.storage_limit) {
                            this._fix_storage_limit(drive.storage);
                            // drive.storage.limit = this.storage_limit;
                            // let limited_total = this.storage_limit;
                            // let limited_free = limited_total - used_size;
                            // drive.storage.total = Math.min(limited_total, drive.storage.total);
                            // drive.storage.free = Math.min(limited_free, drive.storage.free);
                        }
                        return true;
                    } else {
                        return false;
                    }
                });
                reply.drives = used_drives;
                dbg.log0('DRIVES:', drives, 'used drives', used_drives);
                // _.each(drives, drive => {
                //     if (this.storage_path_mount === drive.mount) {
                //         drive.storage.used = used_size;
                //     }
                // });
            })
            .return(reply);
    }

    update_auth_token(req) {
        const auth_token = req.rpc_params.auth_token;
        dbg.log0('update_auth_token: received new token');
        return P.resolve()
            .then(() => {
                if (this.storage_path) {
                    const token_path = path.join(this.storage_path, 'token');
                    dbg.log0('update_auth_token: write new token', token_path);
                    return fs.writeFileAsync(token_path, auth_token);
                }
            })
            .then(() => {
                dbg.log0('update_auth_token: using new token');
                this.client.options.auth_token = auth_token;
            });
    }

    update_rpc_config(req) {
        const n2n_config = req.rpc_params.n2n_config;
        const rpc_address = req.rpc_params.rpc_address;
        const old_rpc_address = this.rpc_address;
        const base_address = req.rpc_params.base_address;
        const old_base_address = this.rpc.router.default;
        dbg.log0('update_rpc_config', req.rpc_params);

        this._update_rpc_config_internal({
            n2n_config: n2n_config,
            rpc_address: rpc_address,
            old_rpc_address: old_rpc_address,
            base_address: base_address,
            old_base_address: old_base_address,
        });
    }

    n2n_signal(req) {
        return this.rpc.accept_n2n_signal(req.rpc_params);
    }

    test_store_perf(req) {
        const reply = {};
        const count = req.rpc_params.count || 5;
        const delay_ms = 200;
        const data = crypto.randomBytes(1024);
        const block_md = {
            id: '_test_store_perf',
            digest_type: 'sha1',
            digest_b64: crypto.createHash('sha1')
                .update(data).digest('base64')
        };
        return test_average_latency(count, delay_ms, () =>
                this.block_store._write_block(block_md, data))
            .then(write_latencies => {
                reply.write = write_latencies;
            })
            .then(() => test_average_latency(count, delay_ms, () =>
                this.block_store._read_block(block_md)))
            .then(read_latencies => {
                reply.read = read_latencies;
            })
            .return(reply);
    }

    test_network_perf(req) {
        const data = req.rpc_params.data;
        const req_len = data ? data.length : 0;
        const res_len = req.rpc_params.response_length;

        dbg.log1('test_network_perf:',
            'req_len', req_len,
            'res_len', res_len,
            'source', req.rpc_params.source,
            'target', req.rpc_params.target);

        if (req.rpc_params.target !== this.rpc_address) {
            throw new Error('test_network_perf: wrong address ' +
                req.rpc_params.target + ' mine is ' + this.rpc_address);
        }

        return {
            data: new Buffer(res_len)
        };
    }

    test_network_perf_to_peer(req) {
        const target = req.rpc_params.target;
        const source = req.rpc_params.source;
        const req_len = req.rpc_params.request_length;
        const res_len = req.rpc_params.response_length;
        const concur = req.rpc_params.concur;
        let count = req.rpc_params.count;

        dbg.log0('test_network_perf_to_peer:',
            'source', source,
            'target', target,
            'req_len', req_len,
            'res_len', res_len,
            'count', count,
            'concur', concur);

        if (source !== this.rpc_address) {
            throw new Error('test_network_perf_to_peer: wrong address ' +
                source + ' mine is ' + this.rpc_address);
        }
        const reply = {};

        const next = () => {
            if (count <= 0) return;
            count -= 1;
            // read/write from target agent
            return this.client.agent.test_network_perf({
                    source: source,
                    target: target,
                    data: new Buffer(req_len),
                    response_length: res_len,
                }, {
                    address: target,
                    return_rpc_req: true // we want to check req.connection
                })
                .then(io_req => {
                    const data = io_req.reply.data;
                    if (((!data || !data.length) && res_len > 0) ||
                        (data && data.length && data.length !== res_len)) {
                        throw new Error('test_network_perf_to_peer: response_length mismatch');
                    }
                    const session = io_req.connection.session;
                    reply.session = session && session.key;
                    return next();
                });
        };

        return P.all(_.times(concur, next)).return(reply);
    }

    collect_diagnostics(req) {
        dbg.log1('Recieved diag req', req);
        const is_windows = (process.platform === "win32");
        const inner_path = is_windows ? process.env.ProgramData + '/agent_diag.tgz' : '/tmp/agent_diag.tgz';

        return P.resolve()
            .then(() => diag.collect_agent_diagnostics())
            .then(() => diag.pack_diagnostics(inner_path))
            .catch(err => {
                dbg.error('DIAGNOSTICS COLLECTION FAILED', err.stack || err);
                throw new Error('Agent Collect Diag Error on collecting diagnostics');
            })
            .then(() => {
                dbg.log1('Reading packed file');
                return fs.readFileAsync(inner_path)
                    .then(data => ({
                        data: new Buffer(data),
                    }))
                    .catch(err => {
                        dbg.error('DIAGNOSTICS READ FAILED', err.stack || err);
                        throw new Error('Agent Collect Diag Error on reading packges diag file');
                    });
            })
            .catch(err => {
                dbg.error('DIAGNOSTICS FAILED', err.stack || err);
                return {
                    data: new Buffer(),
                };
            });
    }

    set_debug_node(req) {
        dbg.set_level(req.rpc_params.level, 'core');
        dbg.log1('Recieved set debug req ', req.rpc_params.level);
        if (req.rpc_params.level > 0) { //If level was set, unset it after a T/O
            promise_utils.delay_unblocking(config.DEBUG_MODE_PERIOD)
                .then(() => {
                    dbg.set_level(0, 'core');
                });
        }
    }

}


function test_average_latency(count, delay_ms, func) {
    const results = [];
    return promise_utils.loop(count + 1, () => {
            const start = time_utils.millistamp();
            return P.fcall(func).then(() => {
                results.push(time_utils.millistamp() - start);
                // use some jitter delay to avoid serializing on cpu when
                // multiple tests are run together.
                const jitter = 0.5 + Math.random(); // 0.5 - 1.5
                return P.delay(delay_ms * jitter);
            });
        })
        .then(() => {
            // throw the first result which is sometimes skewed
            return results.slice(1);
        });
}


module.exports = Agent;
