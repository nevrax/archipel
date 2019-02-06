const generate = require('nanoid/generate')
const nolookalikes = require('nanoid-dictionary/nolookalikes');

// const EventEmitter = require('events').EventEmitter

const { MapOfMaps } = require('@archipel/util/map')
const { prom, isPromise } = require('@archipel/util/async')

const nanoid = () => generate(nolookalikes, 8)
const setImmediate = setImmediate || fn => setTimeout(fn, 0)

class RpcApi {
  constructor (id) {
    this.api = {}
    this.peers = new Map()
    this.id = id || nanoid()
  }

  use (name, create, opts) {
    this.api[name] = { create, opts }
  }

  addPeer (bus, initialState) {
    const [promise, done] = prom()
    let timeout = setTimeout(() => done(new Error('Timeout.')), 5000)

    const localApi = this._makeLocalApi(initialState)

    const peer = {
      bus,
      localApi,
      callbacks: []
    }

    bus.onmessage(msg => {
      if (msg.type === 'hello') {
        let { id, functions } = msg
        peer.id = id
        peer.api = this._makeRemoteApi(id, bus)

        this.peers.set(id, peer)

        clearTimeout(timeout)
        done(null, peer)

      } else {
        this.postMessage(msg)
      }
    })

    setImmediate(() => {
      bus.postMessage({ type: 'hello', id: this.id, methods: localApi.methods })
    })

    return promise
  }

  postMessage (msg) {
    if (msg.type === 'call' && msg.to.peer === this.id) return this.localCall(msg)
    else console.log('Unhandled message', msg)
  }

  localCall (msg) {
    let { from, to, args } = msg

    if (!this.peers.has(from.peer)) throw new Error('Unknown peer: ' + from.peer)

    let peer = this.peers.get(from.peer)

    let fn
    if (to.method) {
      fn = method.split('.').reduce((ret, key) => {
        if (ret && ret[key]) return ret[key]
        else return null
      }, peer.localApi)
    } else if (to.callback) {
      fn = peer.callbacks[callback]
    }

    if (!fn || typeof fn !== 'function') throw new Error('Target not found: ' + to)

    args = this.decodeArgs(peer, args)

    let ret = fn.apply(fn, args)

    if (from.callback) {
      Promise.resolve(ret).then(res => {
        this.pushCall(from, [undefined, res], false)
      }).catch(err => {
        this.pushCall(from, [err, undefined], false)
      })
    }
  }

  pushCall (address, args, returnPromise) {
    let promise, done

    let peer = this.peers.get(address.peer)
    if (!peer) throw new Error('Unknown peer: ' + address.peer)

    let from = { peer: this.id }

    if (returnPromise) {
      [promise, done] = prom()
      from.callback = this.saveCallback(peer, done)
    }

    let msg = {
      type: 'call',
      from,
      to: address
    }

    msg.args = this.encodeArgs(peer, args)
    peer.bus.postMessage(msg)
    return promise
  }

  saveCallback (peer, cb) {
    let idx = peer.callbacks.push(cb)
    return idx - 1
  }

  _makeRemoteApi (peer) {
    let { id, bus, methods } = peer
    let api = {}
    methods.map(name => {
      let cur = api
      let path = name.split('.')

      let fn = path.pop()
      path.forEach((el, i) => {
        cur[el] = cur[el] || {}
        cur = cur[el]
      })

      cur[fn] = (...args) => this.pushCall({ peer: id, method: name }, args, true)
    })
    return api
  }

  _makeLocalApi (initialState) {
    let state = initialState || {}
    let api = {}
    Object.entries(this.api).forEach(([name, { create, opts }]) => {
      api[name] = create(api, state, opts)
    })

    let methods = []
    reduce(api, [])

    return { api, methods, state }

    function reduce (obj, path) {
      Object.entries(obj).forEach(([name, value]) => {
        if (typeof value === 'function') {
          methods.push([...path, name].join('.'))
        } else if (typeof value === 'object') {
          reduce(value, [...path, name])
        }
      })
    }
  }

  encodeArgs (peer, args) {
    if (!args || !args.length) return []
    return args.map(arg => {
      if (arg instanceof Error) throw arg // todo: how to deal with errors?
      // if (hasRef(arg)) return { type: 'ref', ref: getRef(arg) }
      if (typeof arg === 'function') return { type: 'callback', value: this.saveCallback(peer, arg) }
      return { type: 'value', value: arg }
    })
  }

  decodeArgs (peer, args) {
    if (!args || !args.length) return []
    return args.map(arg => {
      if (arg.type === 'callback') return (...args) => this.pushCall({ peer: peer.id, callback: arg }, args)
      if (arg.type === 'value') return arg.value
      else throw new Error('Unkown arg type: ' + arg.type)
    })
  }
}
