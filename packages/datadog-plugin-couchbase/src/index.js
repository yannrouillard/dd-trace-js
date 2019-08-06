'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx.js')

function startQuerySpan (queryType, resource, tracer, config) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan('couchbase.call', {
    childOf,
    tags: {
      'db.type': 'couchbase',
      'span.type': 'sql',
      'component': 'couchbase',
      'service.name': config.service || `${tracer._service}-couchbase`,
      'resource.name': resource,
      'query.type': queryType,
      [Tags.SPAN_KIND]: Kinds.CLIENT
    }
  })

  analyticsSampler.sample(span, config.analytics)
  return span
}

function onRequestFinish (emitter, span) {
  const errorListener = (err) => {
    span.setTag(Tags.ERROR, err)
    span.finish()
  }
  const rowsListener = () => {
    span.finish()
  }

  emitter.once('rows', () => {
    rowsListener()
    emitter.removeListener('error', errorListener)
  })
  emitter.once('error', (err) => {
    errorListener(err)
    emitter.removeListener('rows', rowsListener)
  })
}

function createWrapMaybeInvoke (tracer) {
  return function wrapMaybeInvoke (_maybeInvoke) {
    return function maybeInvokeWithTrace (fn, args) {
      const scope = tracer.scope()

      fn = scope.bind(fn)
      return _maybeInvoke.call(this, fn, args)
    }
  }
}

function createWrapN1qlQuery (tracer, config) {
  return function wrapN1qlQuery (_n1ql) {
    return function n1qlQueryWithTrace (query) {
      const scope = tracer.scope()
      const n1qlQuery = query.options.statement
      const span = startQuerySpan('n1ql', n1qlQuery, tracer, config)

      arguments[2] = tx.wrap(span, arguments[2])

      const req = scope.bind(_n1ql, span).apply(this, arguments)
      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapN1qlRequest (tracer) {
  return function wrapN1qlRequest (_n1qlReq) {
    return function n1qlRequestWithTrace (host, q, adhoc, emitter) {
      const span = tracer.scope().active()

      span.addTags({
        'cluster.host': host,
        'bucket': this.name
      })

      return _n1qlReq.apply(this, arguments)
    }
  }
}

function createWrapViewQuery (tracer, config) {
  return function wrapViewQuery (_view) {
    return function viewQueryWithTrace () {
      const ddoc = arguments[1]
      const viewName = arguments[2]
      const callback = arguments[_view.length - 1]
      const scope = tracer.scope()
      const span = startQuerySpan('view', viewName, tracer, config)

      span.setTag('ddoc', ddoc)
      arguments[_view.length - 1] = tx.wrap(span, callback)

      const req = scope.bind(_view, span).apply(this, arguments)
      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapViewRequest (tracer) {
  return function wrapViewRequest (_viewReq) {
    return function viewRequestWithTrace () {
      const span = tracer.scope().active()

      span.addTags({
        'bucket': this.name
      })

      return _viewReq.apply(this, arguments)
    }
  }
}

function createWrapFtsQuery (tracer, config) {
  return function wrapFtsQuery (_fts) {
    return function ftsQueryWithTrace (query) {
      const scope = tracer.scope()
      const index = query.data.indexName
      const span = startQuerySpan('search', index, tracer, config)

      arguments[1] = tx.wrap(span, arguments[1])

      const req = scope.bind(_fts, span).apply(this, arguments)

      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapFtsRequest (tracer) {
  return function wrapFtsRequest (_ftsReq) {
    return function ftsRequestWithTrace () {
      const span = tracer.scope().active()

      span.addTags({
        'bucket': this.name
      })

      return _ftsReq.apply(this, arguments)
    }
  }
}

function createWrapCbasQuery (tracer, config) {
  return function wrapCbasQuery (_cbas) {
    return function cbasQueryWithTrace (query) {
      const scope = tracer.scope()
      const cbasQuery = query.options.statement
      const span = startQuerySpan('cbas', cbasQuery, tracer, config)

      arguments[2] = tx.wrap(span, arguments[2])

      const req = scope.bind(_cbas, span).apply(this, arguments)
      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapCbasRequest (tracer) {
  return function wrapCbasRequest (_cbasReq) {
    return function cbasRequestWithTrace (host, q, emitter) {
      const span = tracer.scope().active()

      span.addTags({
        'cbas.host': host,
        'bucket': this.name
      })

      return _cbasReq.apply(this, arguments)
    }
  }
}

function createWrapOpenBucket (tracer) {
  return function wrapOpenBucket (openBucket) {
    return function openBucketWithTrace () {
      const bucket = openBucket.apply(this, arguments)
      return tracer.scope().bind(bucket)
    }
  }
}

module.exports = [
  {
    name: 'couchbase',
    versions: ['>=2.4.2'],
    file: 'lib/bucket.js',
    patch (Bucket, tracer, config) {
      this.wrap(Bucket.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))

      this.wrap(Bucket.prototype, '_n1ql', createWrapN1qlQuery(tracer, config))
      this.wrap(Bucket.prototype, '_n1qlReq', createWrapN1qlRequest(tracer))

      this.wrap(Bucket.prototype, '_view', createWrapViewQuery(tracer, config))
      this.wrap(Bucket.prototype, '_viewReq', createWrapViewRequest(tracer, config))

      this.wrap(Bucket.prototype, '_fts', createWrapFtsQuery(tracer, config))
      this.wrap(Bucket.prototype, '_ftsReq', createWrapFtsRequest(tracer, config))

      if (Bucket.prototype._cbas) {
        this.wrap(Bucket.prototype, '_cbas', createWrapCbasQuery(tracer, config))
        this.wrap(Bucket.prototype, '_cbasReq', createWrapCbasRequest(tracer))
      }
    },
    unpatch (Bucket) {
      this.unwrap(Bucket.prototype, '_maybeInvoke')

      this.unwrap(Bucket.prototype, '_n1ql')
      this.unwrap(Bucket.prototype, '_n1qlReq')

      this.unwrap(Bucket.prototype, '_view')
      this.unwrap(Bucket.prototype, '_viewReq')

      this.unwrap(Bucket.prototype, '_fts')
      this.unwrap(Bucket.prototype, '_ftsReq')

      this.unwrap(Bucket.prototype, '_cbas')
      this.unwrap(Bucket.prototype, '_cbasReq')
    }
  },
  {
    name: 'couchbase',
    versions: ['>=2.4.2'],
    file: 'lib/cluster.js',
    patch (Cluster, tracer, config) {
      this.wrap(Cluster.prototype, 'openBucket', createWrapOpenBucket(tracer, config))
      this.wrap(Cluster.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))

      this.wrap(Cluster.prototype, '_n1ql', createWrapN1qlQuery(tracer, config))
      this.wrap(Cluster.prototype, '_fts', createWrapFtsQuery(tracer, config))
      this.wrap(Cluster.prototype, '_cbas', createWrapCbasQuery(tracer, config))
    },
    unpatch (Cluster) {
      this.unwrap(Cluster.prototype, 'openBucket')
      this.unwrap(Cluster.prototype, '_maybeInvoke')

      this.unwrap(Cluster.prototype, '_n1ql')
      this.unwrap(Cluster.prototype, '_fts')
      this.unwrap(Cluster.prototype, '_cbas')
    }
  }
]