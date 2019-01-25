const redis = require('redis');
const crypto = require('crypto');
const QueryQueue = require('./QueryQueue');
const ContinueWaitError = require('./ContinueWaitError');

const redisClient = redis.createClient(process.env.REDIS_URL);

class QueryCache {
  constructor(redisPrefix, clientFactory, logger) {
    this.redisPrefix = redisPrefix;
    this.clientFactory = clientFactory;
    this.logger = logger;
  }

  cachedQueryResult (queryBody, preAggregationsTablesToTempTables) {
    const replacePreAggregationTableNames = (queryAndParams) =>
      QueryCache.replacePreAggregationTableNames(queryAndParams, preAggregationsTablesToTempTables);

    const query = replacePreAggregationTableNames(queryBody.query);
    let queuePriority = 10;
    if (Number.isInteger(queryBody.queuePriority)) {
      queuePriority = queryBody.queuePriority;
    }
    const forceNoCache = queryBody.forceNoCache || false;
    const values = queryBody.values;
    const cacheKeyQueries =
      (
        queryBody.cacheKeyQueries && queryBody.cacheKeyQueries.queries ||
        queryBody.cacheKeyQueries ||
        []
      ).map(replacePreAggregationTableNames);

    const renewalThreshold = queryBody.cacheKeyQueries && queryBody.cacheKeyQueries.renewalThreshold;

    const expireSecs = queryBody.expireSecs || 24 * 3600;

    if (!cacheKeyQueries) {
      return this.queryWithRetryAndRelease(query, values);
    }
    const cacheKey = QueryCache.queryCacheKey(queryBody);

    if (queryBody.renewQuery) {
      this.logger('Requested renew', { cacheKey });
      return this.renewQuery(query, values, cacheKeyQueries, expireSecs, cacheKey, renewalThreshold);
    }

    const mainPromise = this.cacheQueryResult(
      query, values,
      cacheKey,
      expireSecs,
      {
        priority: queuePriority,
        forceNoCache,
      }
    );

    if (!forceNoCache) {
      this.startRenewCycle(query, values, cacheKeyQueries, expireSecs, cacheKey, renewalThreshold);
    }

    return mainPromise;
  }

  static queryCacheKey(queryBody) {
    return [queryBody.query, queryBody.values, (queryBody.preAggregations || []).map(p => p.loadSql)];
  }

  static replaceAll(replaceThis, withThis, inThis) {
    withThis = withThis.replace(/\$/g,"$$$$");
    return inThis.replace(
      new RegExp(replaceThis.replace(/([/,!\\^${}[\]().*+?|<>\-&])/g,"\\$&"),"g"),
      withThis
    );
  }

  static replacePreAggregationTableNames (queryAndParams, preAggregationsTablesToTempTables) {
    const [keyQuery, params] = Array.isArray(queryAndParams) ? queryAndParams : [queryAndParams, []];
    const replacedKeqQuery = preAggregationsTablesToTempTables.reduce(
      (query, [tableName, tempTable]) => QueryCache.replaceAll(tableName, tempTable, query),
      keyQuery
    );
    return Array.isArray(queryAndParams) ? [replacedKeqQuery, params] : replacedKeqQuery;
  }

  queryWithRetryAndRelease(query, values, priority, cacheKey) {
    const queue = this.getQueue();
    return queue.executeInQueue('query', cacheKey, { query, values}, priority, { stageQueryKey: cacheKey });
  }

  getQueue () {
    if (!this.queue) {
      this.queue = QueryCache.createQueue(
        `SQL_QUERY_${this.redisPrefix}`,
        this.clientFactory,
        (client, q) => client.query(q.query, q.values),
        { logger: this.logger }
      );
    }
    return this.queue;
  }

  static createQueue(redisPrefix, clientFactory, executeFn, options) {
    options = options || {};
    const queue = new QueryQueue(redisPrefix, {
      queryHandlers: {
        query: async (q, setCancelHandle) => {
          const client = await clientFactory();
          const resultPromise = executeFn(client, q);
          let handle;
          if (resultPromise.cancel) {
            queue.cancelHandlerCounter += 1;
            handle = queue.cancelHandlerCounter;
            queue.handles[handle] = resultPromise;
            await setCancelHandle(handle);
          }
          const result = await resultPromise;
          if (handle) {
            delete queue.handles[handle];
          }
          return result;
        }
      },
      cancelHandlers: {
        query: async (q) => {
          if (q.cancelHandler && queue.handles[q.cancelHandler]) {
            await queue.handles[q.cancelHandler].cancel();
            delete queue.handles[q.cancelHandler];
          }
        }
      },
      logger: (msg, params) => options.logger(msg, params),
      ...options
    });
    queue.cancelHandlerCounter = 0;
    queue.handles = {};
    return queue;
  }

  startRenewCycle(query, values, cacheKeyQueries, expireSecs, cacheKey, renewalThreshold) {
    this.renewQuery(
      query, values, cacheKeyQueries, expireSecs, cacheKey, renewalThreshold
    ).catch(e => {
      if (!(e instanceof ContinueWaitError)) {
        this.logger('Error while renew cycle', { query, query_values: values, error: e.stack || e })
      }
    })
  }

  renewQuery(query, values, cacheKeyQueries, expireSecs, cacheKey, renewalThreshold) {
    return Promise.all(
      cacheKeyQueries.map(q =>
        this.cacheQueryResult(
          Array.isArray(q) ? q[0] : q,
          Array.isArray(q) ? q[1] : [],
          q,
          expireSecs,
          { renewalThreshold: 2 * 60, renewalKey: q, waitForRenew: true }
        )
      )
    )
      .catch(e => {
        if (e instanceof ContinueWaitError) {
          throw e;
        }
        this.logger('Error fetching cache key queries', { error: e.stack || e });
        return [];
      })
      .then(cacheKeyQueryResults => {
        return this.cacheQueryResult(
          query, values,
          cacheKey,
          expireSecs,
          {
            renewalThreshold: renewalThreshold || 6 * 60 * 60,
            renewalKey: cacheKeyQueryResults && [
              cacheKeyQueries, cacheKeyQueryResults, this.queryRedisKey([query, values])
            ],
            waitForRenew: true
          }
        );
      });
  }

  cacheQueryResult(query, values, cacheKey, expiration, options) {
    options = options || {};
    const renewalThreshold = options.renewalThreshold;
    const renewalKey = options.renewalKey && this.queryRedisKey(options.renewalKey);
    const redisKey = this.queryRedisKey(cacheKey);
    const fetchNew = () => {
      return this.queryWithRetryAndRelease(query, values, options.priority, cacheKey).then(res => {
        const result = {
          time: (new Date()).getTime(),
          result: res,
          renewalKey
        };
        return redisClient.setAsync(redisKey, JSON.stringify(result), 'EX', expiration)
          .then(() => {
            this.logger('Renewed', { cacheKey });
            return res
          });
      }).catch(e => {
        if (!(e instanceof ContinueWaitError)) {
          this.logger('Dropping Cache', { cacheKey, error: e.stack || e });
          redisClient.delAsync(redisKey)
            .catch(e => this.logger('Error removing key', { cacheKey, error: e.stack || e }));
        }
        throw e;
      });
    };

    if (options.forceNoCache) {
      this.logger('Force no cache for', { cacheKey });
      return fetchNew();
    }

    return redisClient.getAsync(redisKey).then(res => {
      if (res) {
        const parsedResult = JSON.parse(res);
        const renewedAgo = (new Date()).getTime() - parsedResult.time;
        this.logger('Found cache entry', {
          cacheKey,
          time: parsedResult.time,
          renewedAgo,
          renewalKey: parsedResult.renewalKey,
          newRenewalKey: renewalKey,
          renewalThreshold
        });
        if (
          renewalKey && (
            !renewalThreshold ||
            !parsedResult.time ||
            renewedAgo > renewalThreshold * 1000 ||
            parsedResult.renewalKey !== renewalKey
          )
        ) {
          if (options.waitForRenew) {
            this.logger('Waiting for renew', { cacheKey, renewalThreshold });
            return fetchNew();
          } else {
            this.logger('Renewing existing key', { cacheKey, renewalThreshold });
            fetchNew().catch(e => {
              if (!(e instanceof ContinueWaitError)) {
                this.logger('Error renewing', {cacheKey, error: e.stack || e})
              }
            });
          }
        }
        this.logger('Using cache for', { cacheKey });
        return parsedResult.result;
      } else {
        this.logger('Missing cache for', { cacheKey });
        return fetchNew();
      }
    });
  }

  queryRedisKey(cacheKey) {
    return `SQL_QUERY_RESULT_${this.redisPrefix}_${crypto.createHash('md5').update(JSON.stringify(cacheKey)).digest("hex")}`
  }
}

module.exports = QueryCache;