/* Copyright (C) 2024 NooBaa */
/* eslint-disable max-lines-per-function */

'use strict';

const nsfs_schema_utils = require('../../../../manage_nsfs/nsfs_schema_utils');
const RpcError = require('../../../../rpc/rpc_error');
const config = require('../../../../../config');

describe('schema validation NC NSFS config', () => {

    describe('config with all needed properties', () => {

        it('nsfs_config - valid simple', () => {
            const config_data = {
                ALLOW_HTTP: true,
                NSFS_NC_STORAGE_BACKEND: 'GPFS',
                NSFS_NC_CONFIG_DIR_BACKEND: 'CEPH_FS',
                FORKS: 20,
                NSFS_DIR_CACHE_MAX_DIR_SIZE: 67108864,
                NSFS_DIR_CACHE_MAX_TOTAL_SIZE: 268435456,
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config - recommendation', () => {
            const config_data = {
                ENDPOINT_PORT: 80,
                ENDPOINT_SSL_PORT: 443,
                ENDPOINT_FORKS: 16,
                UV_THREADPOOL_SIZE: 256,
                GPFS_DL_PATH: '/usr/lpp/mmfs/lib/libgpfs.so',
                NSFS_NC_STORAGE_BACKEND: 'GPFS',
                NSFS_NC_CONFIG_DIR_BACKEND: 'GPFS',
                NSFS_BUF_POOL_MEM_LIMIT: 4294967296,
                NSFS_OPEN_READ_MODE: 'rd',
                NSFS_CHECK_BUCKET_BOUNDARIES: false,
                ALLOW_HTTP: true,
                S3_SERVER_IP_WHITELIST: [
                    '127.0.0.1',
                    '0000:0000:0000:0000:0000:ffff:7f00:0002',
                    '::ffff:7f00:3'
                ],
                NSFS_DIR_CACHE_MAX_DIR_SIZE: 268435456,
                NSFS_DIR_CACHE_MAX_TOTAL_SIZE: 805306368,
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });
    });

    describe('config with wrong types', () => {

        it('nsfs_config invalid ALLOW_HTTP', () => {
            const config_data = {
                ALLOW_HTTP: 123, // number instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
                'ALLOW_HTTP with number (instead of boolean)';
            const message = 'must be boolean';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid forks', () => {
            const config_data = {
                ENDPOINT_FORKS: true, // boolean instead of number
            };
            const reason = 'Test should have failed because of wrong type ' +
                'ENDPOINT_FORKS with boolean (instead of number)';
            const message = 'must be number';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid storage fs_backend', () => {
            const config_data = {
                NSFS_NC_STORAGE_BACKEND: 'INVALID_FS_BACKEND', // not part of definition of fs_backend
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NSFS_NC_STORAGE_BACKEND with boolean (instead of number)';
            const message = 'must be equal to one of the allowed values';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config dir fs_backend', () => {
            const config_data = {
                NSFS_NC_CONFIG_DIR_BACKEND: 123, // number instead of string
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NSFS_NC_CONFIG_DIR_BACKEND with number (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config dir dir cache max dir size', () => {
            const config_data = {
                NSFS_DIR_CACHE_MAX_DIR_SIZE: 'not a number', // string instead of number
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NSFS_DIR_CACHE_MAX_DIR_SIZE with number (instead of string)';
            const message = 'must be number';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config dir dir cache max total size', () => {
            const config_data = {
                NSFS_DIR_CACHE_MAX_TOTAL_SIZE: 'not a number', // string instead of number
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NSFS_DIR_CACHE_MAX_TOTAL_SIZE with number (instead of string)';
            const message = 'must be number';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config disable random seed', () => {
            const config_data = {
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
                'ENABLE_DEV_RANDOM_SEED with string (instead of boolean)';
            const message = 'must be boolean';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config master keys GET executable', () => {
            const config_data = {
                NC_MASTER_KEYS_GET_EXECUTABLE: false, // boolean instead of string
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NC_MASTER_KEYS_GET_EXECUTABLE with boolean (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config master keys PUT executable', () => {
            const config_data = {
                NC_MASTER_KEYS_PUT_EXECUTABLE: false, // boolean instead of string
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NC_MASTER_KEYS_PUT_EXECUTABLE with boolean (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config master keys store type - unallowed value', () => {
            const config_data = {
                NC_MASTER_KEYS_STORE_TYPE: 'not_file_nor_script', // unallowed value, string type
            };
            const reason = 'Test should have failed because of unallowed value ' +
                'NC_MASTER_KEYS_STORE_TYPE with boolean (instead of string)';
            const message = 'must be equal to one of the allowed values | {"allowedValues":["file","executable"]}';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config master keys store type - different type', () => {
            const config_data = {
                NC_MASTER_KEYS_STORE_TYPE: false, // unallowed value, boolean type
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NC_MASTER_KEYS_STORE_TYPE with boolean (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config master keys file location', () => {
            const config_data = {
                NC_MASTER_KEYS_FILE_LOCATION: false, // boolean instead of string
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NC_MASTER_KEYS_FILE_LOCATION with boolean (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config virtual hosts', () => {
            const config_data = {
                VIRTUAL_HOSTS: 5, // number instead of string
            };
            const reason = 'Test should have failed because of wrong type ' +
                'VIRTUAL_HOSTS with number (instead of string)';
            const message = 'must be string';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config disable access check', () => {
            const config_data = { NC_DISABLE_ACCESS_CHECK: true };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config invalid config disable access check', () => {
            const config_data = { NC_DISABLE_ACCESS_CHECK: 'bla' }; // string instead of boolean
            const reason = 'Test should have failed because of wrong type ' +
                'NC_DISABLE_ACCESS_CHECK with string (instead of boolean)';
            const message = 'must be boolean';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config disable health access check', () => {
            const config_data = { NC_DISABLE_HEALTH_ACCESS_CHECK: true };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config invalid config disable health access check', () => {
            const config_data = { NC_DISABLE_HEALTH_ACCESS_CHECK: 'bla' }; // string instead of boolean
            const reason = 'Test should have failed because of wrong type ' +
                'NC_DISABLE_HEALTH_ACCESS_CHECK with string (instead of boolean)';
            const message = 'must be boolean';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config disable posix access check', () => {
            const config_data = { NC_DISABLE_POSIX_MODE_ACCESS_CHECK: false };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config invalid config disable posix access check', () => {
            const config_data = {
                NC_DISABLE_POSIX_MODE_ACCESS_CHECK: 'bla'// string instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
                'NC_DISABLE_POSIX_MODE_ACCESS_CHECK with string (instead of boolean)';
            const message = 'must be boolean';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid config virtual hosts', () => {
            const config_data = {
                VIRTUAL_HOSTS: 'my.virtual.domain1 my.virtual.domain2'
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config invalid config hostname - invalid configuration in hostname', () => {
            const hostname = "hostname1";
            const config_data = {
                "ALLOW_HTTP": false,
                host_customization: {
                    [hostname]: {
                        "ALLOW_HTTP": 'str'
                    }
                }
            };
            const reason = 'Test should have failed because of wrong type ' +
                'host_customization - ALLOW HTTP must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/host_customization/${hostname}/ALLOW_HTTP"`;
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config invalid config hostname - invalid hostname - should succeed', () => {
            const invalid_hostname = "not.$a.valid!.hostname";
            const config_data = {
                "ALLOW_HTTP": false,
                host_customization: {
                    [invalid_hostname]: {
                        "ALLOW_HTTP": true
                    }
                }
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config valid config hostname', () => {
            const config_data = {
                "ALLOW_HTTP": false,
                host_customization: {
                    "a.valid-valid.hostname": {
                        "ALLOW_HTTP": true
                    }
                }
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config invalid process title', () => {
            const config_data = {
                "ENDPOINT_PROCESS_TITLE": false,
            };
            const reason = 'Test should have failed because of wrong type ' +
                'ENDPOINT_PROCESS_TITLE must be string';
            const message = `must be string | {"type":"string"} | "/ENDPOINT_PROCESS_TITLE"`;
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config valid process title', () => {
            const config_data = {
                "ENDPOINT_PROCESS_TITLE": 'noobaa_60',
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config valid and empty process title', () => {
            const config_data = {
                "ENDPOINT_PROCESS_TITLE": '',
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config valid NOTIFICATION_REQ_PER_SPACE_CHECK', () => {
            const config_data = {
                NOTIFICATION_REQ_PER_SPACE_CHECK: 300
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config valid NOTIFICATION_REQ_PER_SPACE_CHECK', () => {
            const config_data = {
                NOTIFICATION_REQ_PER_SPACE_CHECK: 0
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config valid NOTIFICATION_SPACE_CHECK_THRESHOLD', () => {
            const config_data = {
                NOTIFICATION_SPACE_CHECK_THRESHOLD: 0.11
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('nsfs_config check invalid NOTIFICATION_REQ_PER_SPACE_CHECK', () => {
            const config_data = {
                "NOTIFICATION_REQ_PER_SPACE_CHECK": 'asd',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'NOTIFICATION_REQ_PER_SPACE_CHECK with string (instead of number)';
            const message = 'must be number';
            assert_validation(config_data, reason, message);
        });

        it('nsfs_config check invalid NOTIFICATION_SPACE_CHECK_THRESHOLD', () => {
            const config_data = {
                "NOTIFICATION_SPACE_CHECK_THRESHOLD": 'asd',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'NOTIFICATION_SPACE_CHECK_THRESHOLD with string (instead of number)';
            const message = 'must be number';
            assert_validation(config_data, reason, message);
        });
    });

    describe('skip/unskip schema check by config test', () => {
        afterAll(async () => {
            config.NC_DISABLE_SCHEMA_CHECK = false;
        });

        it('skip schema check - config.NC_DISABLE_SCHEMA_CHECK=false nsfs_config.NC_DISABLE_SCHEMA_CHECK=true - invalid config - should pass', () => {
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: true,
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('unskip schema check - config.NC_DISABLE_SCHEMA_CHECK=true nsfs_config.NC_DISABLE_SCHEMA_CHECK=false - invalid config - should fail', () => {
            config.NC_DISABLE_SCHEMA_CHECK = true;
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: false,
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
            'ENABLE_DEV_RANDOM_SEED must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/ENABLE_DEV_RANDOM_SEED"`;
            assert_validation(config_data, reason, message);
        });

        it('skip schema check - config.NC_DISABLE_SCHEMA_CHECK=true nsfs_config.NC_DISABLE_SCHEMA_CHECK=undefined - invalid config - should pass', () => {
            config.NC_DISABLE_SCHEMA_CHECK = true;
            const config_data = {
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('unskip schema check - config.NC_DISABLE_SCHEMA_CHECK=false nsfs_config.NC_DISABLE_SCHEMA_CHECK=undefined - invalid config - should fail', () => {
            config.NC_DISABLE_SCHEMA_CHECK = false;
            const config_data = {
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
            'ENABLE_DEV_RANDOM_SEED must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/ENABLE_DEV_RANDOM_SEED"`;
            assert_validation(config_data, reason, message);
        });

        it('skip schema check - config.NC_DISABLE_SCHEMA_CHECK=true nsfs_config.NC_DISABLE_SCHEMA_CHECK=true - invalid config - should pass', () => {
            config.NC_DISABLE_SCHEMA_CHECK = true;
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: true,
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            nsfs_schema_utils.validate_nsfs_config_schema(config_data);
        });

        it('unskip schema check - config.NC_DISABLE_SCHEMA_CHECK=false nsfs_config.NC_DISABLE_SCHEMA_CHECK=false - invalid config - should fail', () => {
            config.NC_DISABLE_SCHEMA_CHECK = false;
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: false,
                ENABLE_DEV_RANDOM_SEED: 'not boolean', // string instead of boolean
            };
            const reason = 'Test should have failed because of wrong type ' +
            'ENABLE_DEV_RANDOM_SEED must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/ENABLE_DEV_RANDOM_SEED"`;
            assert_validation(config_data, reason, message);
        });

        it('unskip schema check - config.NC_DISABLE_SCHEMA_CHECK=true nsfs_config.NC_DISABLE_SCHEMA_CHECK=bla - invalid config - should pass', () => {
            config.NC_DISABLE_SCHEMA_CHECK = true;
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: 'bla',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'NC_DISABLE_SCHEMA_CHECK must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/NC_DISABLE_SCHEMA_CHECK"`;
            assert_validation(config_data, reason, message);
        });

        it('unskip schema check - config.NC_DISABLE_SCHEMA_CHECK=false nsfs_config.NC_DISABLE_SCHEMA_CHECK=bla - invalid config - should fail', () => {
            config.NC_DISABLE_SCHEMA_CHECK = false;
            const config_data = {
                NC_DISABLE_SCHEMA_CHECK: 'bla',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'NC_DISABLE_SCHEMA_CHECK must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/NC_DISABLE_SCHEMA_CHECK"`;
            assert_validation(config_data, reason, message);
        });

        it('unskip schema check - config.LOG_TO_SYSLOG_ENABLED=false nsfs_config.LOG_TO_SYSLOG_ENABLED=bla - invalid config - should fail', () => {
            config.LOG_TO_SYSLOG_ENABLED = false;
            const config_data = {
                LOG_TO_SYSLOG_ENABLED: 'bla',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'LOG_TO_SYSLOG_ENABLED must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/LOG_TO_SYSLOG_ENABLED"`;
            assert_validation(config_data, reason, message);
        });

        it('unskip schema check - config.LOG_TO_STDERR_ENABLED=false nsfs_config.LOG_TO_STDERR_ENABLED=bla - invalid config - should fail', () => {
            config.LOG_TO_STDERR_ENABLED = false;
            const config_data = {
                LOG_TO_STDERR_ENABLED: 'bla',
            };
            const reason = 'Test should have failed because of wrong type ' +
            'LOG_TO_STDERR_ENABLED must be boolean';
            const message = `must be boolean | {"type":"boolean"} | "/LOG_TO_STDERR_ENABLED"`;
            assert_validation(config_data, reason, message);
        });
    });
});

function assert_validation(config_to_validate, reason, basic_message) {
    try {
        nsfs_schema_utils.validate_nsfs_config_schema(config_to_validate);
        fail(reason);
    } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect(err).toHaveProperty('message');
        expect((err.message).includes(basic_message)).toBe(true);
    }
}

// Jest has builtin function fail that based on Jasmine
// in case Jasmine would get removed from jest, created this one
// based on this: https://stackoverflow.com/a/55526098/16571658
function fail(reason) {
    throw new Error(reason);
}
