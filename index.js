var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var collect = require('stream-collector')
var thunky = require('thunky')
var extend = require('xtend')
var parallel = require('run-parallel')
var deepEqual = require('deep-equal')
var bitcoin = require('@tradle/bitcoinjs-lib')

// var indexer = require('level-indexer')
var noop = function () {}
var prefixes = {
  address: 'a!',  // watched addresses
  tx: 't!',       // txs
  // addrTx: 'at!'   // txs for a certain address
}

var BATCH_SIZE = 50

exports = module.exports = tracker
exports.mkBatches = mkBatches
exports.parseTx = parseTx
exports.mergeAddrs = mergeAddrs
exports.CONFIRMED_AFTER = 7

function tracker (opts) {
  typeforce({
    db: 'Object',
    blockchain: 'Object',
    networkName: 'String',
    confirmedAfter: '?Number'
  }, opts)

  var db = opts.db
  if (db.options.valueEncoding !== 'json') {
    throw new Error('expected db with valueEncoding "json"')
  }

  var ee = new EventEmitter()

  var confirmedAfter = typeof opts.confirmedAfter === 'number'
    ? opts.confirmedAfter :
    exports.CONFIRMED_AFTER

  var networkName = opts.networkName
  var blockchain = opts.blockchain
  var chainHeight
  var watchedAddrs
  // var watch = indexer(db, ['watch'])

  var init = thunky(function (cb) {
    parallel([
      function (done) {
        collectStuff(prefixes.address, function (err, addrs) {
          watchedAddrs = addrs || []
          done()
        })
      },
      function (done) {
        db.get('chainheight', function (err, height) {
          chainHeight = height || 0
          done()
        })
      }
    ], cb)
  })

  function collectStuff (prefix, cb) {
    collect(db.createReadStream({
      gt: prefix,
      lt: prefix + '\xff'
    }), cb)
  }

  function syncHeight (cb) {
    blockchain.blocks.latest(function (err, info) {
      if (err) return cb(err)

      chainHeight = info.blockHeight
      db.put('chainheight', chainHeight, cb)
    })
  }

  function getNewHeight (cb) {
    blockchain.blocks.latest(function (err, info) {
      if (err) return cb(err)

      if (chainHeight !== info.blockHeight) {
        chainHeight = info.blockHeight
        db.put('chainheight', chainHeight, cb)
      } else {
        cb()
      }
    })
  }

  function syncAddresses (addrs, cb) {
    init(function () {
      parallel(mkBatches(addrs, chainHeight).map(function (batch) {
        return function (cb) {
          runBatch(batch, cb)
        }
      }), cb)
    })
  }

  function runBatch (addrObjs, cb) {
    var addrStrs = addrObjs.map(getProp('address'))
    var minHeight = addrObjs[0].maxBlockHeight - confirmedAfter
    blockchain.addresses.transactions(addrStrs, minHeight, function (err, txInfos) {
      if (err) return cb(err)
      if (!txInfos.length) return cb()

      txInfos = txInfos.map(function (info) {
        return parseTx(info, networkName)
      })

      var txBatch = txInfos.map(function (tx) {
        return {
          type: 'put',
          key: prefixes.tx + tx.txId,
          value: tx
        }
      })

      var addrUpdate = addrObjs.map(function (addrObj) {
        var newMaxHeight = txInfos.reduce(function (height, next) {
          return Math.max(height, next.blockHeight)
        }, 0)

        return extend(addrObj, {
          maxBlockHeight: Math.max(addrObj.maxBlockHeight, newMaxHeight),
          txIds: mergeShallow(
            filterByAddr(txInfos, addrObj.address),
            addrObj.txIds
          )
        })
      })
      .filter(function (addrObj, i) {
        return !deepEqual(addrObj, addrObjs[i])
      })

      watchedAddrs = mergeAddrs(watchedAddrs, addrUpdate)

      var addrBatch = addrUpdate
      .map(function (addrObj) {
        return {
          type: 'put',
          key: prefixes.address + addrObj.address,
          value: addrObj
        }
      })

      db.batch(txBatch.concat(addrBatch), cb)
    })
  }

  function _getAddress (addr) {
    return find(watchedAddrs, function (addrObj) {
      return addrObj.address === addr
    })
  }

  ee.watchAddresses = function watchAddresses (addrs, cb) {
    init(function () {
      addrs = addrs.filter(function (addr) {
        return !_getAddress(addr)
      })

      if (!addrs.length) return cb()

      var addrObjs = addrs.map(newAddressObj)
      watchedAddrs = mergeAddrs(watchedAddrs || [], addrObjs)
      db.batch(addrObjs.map(function (addrObj) {
        return {
          type: 'put',
          key: prefixes.address + addrObj.address,
          value: addrObj
        }
      }), cb)
    })
  }

  // function watchTxs (txs, cb) {
  //   init(function () {
  //     watched.tx = mergeShallow(watched.tx || [], txs)
  //     storeNew(watchedTxs, prefixes.tx, newTxObj, cb || noop)
  //   })
  // }

  ee.getWatchedAddresses = function getWatchedAddresses (cb) {
    init(function () {
      cb(null, watchedAddrs)
    })
  }

  ee.getTxs = function getTxs (addr, cb) {
    init(function () {
      if (typeof addr === 'function') {
        return collectStuff(prefixes.tx, cb)
      }

      var match = _getAddress(addr)
      if (match) {
        ee.lookupTxs(match.txIds, cb)
      } else {
        return process.nextTick(function () {
          cb(new Error('not found'))
        })
      }
    })
  }

  ee.getAddress = function getAddress (addr, cb) {
    init(function () {
      var match = _getAddress(addr)
      if (match) {
        cb(null, match)
      } else {
        process.nextTick(function () {
          cb(new Error('not found'))
        })
      }
    })
  }

  ee.getAddressWithTxs = function getAddressWithTxs (addr, cb) {
    db.get(prefixes.address + addr, addr, function (err, addrObj) {
      if (err) return cb(err)

      ee.lookupTxs(addrObj.txIds, function (err, txs) {
        if (err) return cb(err)

        addrObj.txs = txs
        cb(null, addrObj)
      })
    })
  }

  ee.lookupTxs = function lookupTxs (txIds, cb) {
    parallel(
      txIds.map(function (txId) {
        return function (done) {
          db.get(prefixes.tx + txId, done)
        }
      }),
      cb
    )
  }

  ee.getHeight = function getHeight (cb) {
    init(function () {
      cb(null, chainHeight)
    })
  }

  ee.sync = function sync (cb) {
    init(function () {
      // var oldHeight = chainHeight
      syncHeight(function () {
        // if (chainHeight === oldHeight) return cb()
        // can't skip resync as we have have gotten new addresses to watch

        syncAddresses(watchedAddrs, cb)
      })
    })
  }

  return ee
}

function truthy (obj) {
  return !!obj
}

function newAddressObj (address) {
  return {
    address: address,
    txIds: [],
    maxBlockHeight: 0
  }
}

function newTxObj (txId) {
  return {
    txId: tx,
    confirmations: null
  }
}

function mergeAddrs (left, right) {
  left = left.slice().sort(byAddress)
  right = right.slice().sort(byAddress)
  var i, j
  var merged = []
  while (left.length && right.length) {
    var l = left[0]
    var r = right[0]
    if (l.address !== r.address) {
      merged.push(l)
      left.shift()
    } else {
      if (l.maxBlockHeight >= r.maxBlockHeight) {
        merged.push(l)
      } else {
        merged.push(r)
      }

      left.shift()
      right.shift()
    }
  }

  merged = merged.concat(left, right) // leftovers
  return merged
}

function byAddress (a, b) {
  return a.address < b.address ? -1 : 1
}

function mergeShallow (arr, add) {
  return arr.concat(add.filter(function (addr) {
    return arr.indexOf(addr) === -1
  }))
}

function call (fn) {
  fn()
}

function getProp (prop) {
  return function (obj) {
    return obj[prop]
  }
}

function parseTx (txInfo, networkName) {
  typeforce('String', txInfo.txHex)
  if (!(networkName in bitcoin.networks)) {
    throw new Error('invalid networkName')
  }

  var tx = bitcoin.Transaction.fromHex(txInfo.txHex)
  return extend(txInfo, {
    from: parseTxSender(tx, networkName),
    to: {
      addresses: getOutputAddresses(tx, networkName)
    }
  })
}

function parseTxSender (tx, networkName) {
  var pubkeys = []
  var addrs = []
  tx.ins.map(function (input) {
    var pubKeyBuf = input.script.chunks[1]
    try {
      var pub = bitcoin.ECPubKey.fromBuffer(pubKeyBuf)
      var addr = pub.getAddress(bitcoin.networks[networkName]).toString()
      pubkeys.push(pubKeyBuf)
      addrs.push(addr)
    } catch (err) {}
  })

  return {
    pubkeys: pubkeys,
    addresses: addrs
  }
}

function getTxAddresses (tx, networkName) {
  return getInputAddresses(tx, networkName)
    .concat(getOutputAddresses(tx, networkName))
}

function getOutputAddresses (tx, networkName) {
  return tx.outs.map(function (output) {
    return getAddressFromOutput(output, networkName)
  })
  .filter(truthy)
}

// function getInputAddresses (tx, networkName) {
//   return tx.ins.map(function (input) {
//     return getAddressFromInput(input, networkName)
//   })
//   .filter(truthy)
// }

// function getAddressFromInput (input, networkName) {
//   var pub
//   try {
//     pub = bitcoin.ECPubKey.fromBuffer(input.script.chunks[1])
//     return pub.getAddress(bitcoin.networks[networkName]).toString()
//   } catch (err) {
//   }
// }

function getAddressFromOutput (output, networkName) {
  if (bitcoin.scripts.classifyOutput(output.script) === 'pubkeyhash') {
    return bitcoin.Address
      .fromOutputScript(output.script, bitcoin.networks[networkName])
      .toString()
  }
}

function filterByAddr (txInfos, addr) {
  return txInfos.filter(function (txInfo) {
    return txInfo.from.addresses.indexOf(addr) !== -1 ||
      txInfo.to.addresses.indexOf(addr) !== -1
  })
  .map(getProp('txId'))
}

function mkBatches (addrObjs, chainHeight, batchSize) {
  batchSize = batchSize || BATCH_SIZE

  // sort by increasing height
  addrObjs = addrObjs.filter(function (addr) {
    return addr.maxBlockHeight < chainHeight
  })

  addrObjs.sort(function (a, b) {
    return a.maxBlockHeight - b.maxBlockHeight
  })

  var batches = []
  while (addrObjs.length) {
    batches.push(addrObjs.slice(0, batchSize))
    addrObjs = addrObjs.slice(batchSize)
  }

  // var togo = batches.length
  // batches.forEach(function (batch) {
  //   var minHeight = batch.reduce(function (min, addr) {
  //     return Math.min(min, addr.maxBlockHeight)
  //   }, chainHeight) - exports.CONFIRMED_AFTER

  //   batch.minHeight = Math.max(minHeight, 0)
  // })

  return batches
}

function find (arr, filter) {
  var match
  arr.some(function (item, idx) {
    if (filter(item, idx)) {
      match = item
      return true
    }
  })

  return match
}
