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

function tracker (opts) {
  typeforce({
    db: 'Object',
    blockchain: 'Object',
    networkName: 'String'
  }, opts)

  var db = opts.db
  var networkName = opts.networkName
  var blockchain = opts.blockchain
  var chainHeight
  var watchedAddrs
  // var watch = indexer(db, ['watch'])

  var init = thunky(function (cb) {
    parallel([
      function (cb) {
        collectStuff(prefixes.address, function (err, addrs) {
          watchedAddrs = addrs || []
          cb()
        })
      },
      function (cb) {
        db.get('chainheight', function (err, height) {
          chainHeight = height || 0
          cb()
        })
      }
    ], cb)
  })

  function watchAddresses (addrs, cb) {
    init(function () {
      watchedAddrs = merge(watchedAddrs || [], addrs)
      storeNew(addrs, prefixes.address, newAddressObj, cb || noop)
    })
  }

  // function watchTxs (txs, cb) {
  //   init(function () {
  //     watched.tx = merge(watched.tx || [], txs)
  //     storeNew(watchedTxs, prefixes.tx, newTxObj, cb || noop)
  //   })
  // }

  function getWatchedAddresses (cb) {
    init(function () {
      cb(null, watchedAddrs)
    })
  }

  function getTxs (addr, cb) {
    init(function () {
      if (typeof addr === 'function') {
        return collectStuff(prefix.tx, cb)
      }

      var match = _getAddress(addr)
      if (match) {
        getTxsForAddress(match, cb)
      } else {
        return process.nextTick(function () {
          cb(new Error('not found'))
        })
      }
    })
  }

  function _getAddress (addr) {
    return find(watchedAddrs, function (addrObj) {
      return addrObj.address === addr
    })
  }

  function getAddress (addr, cb) {
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

  function getAddressWithTxs (addr, cb) {
    db.get(prefix.address + addr, addr, function (err, addrObj) {
      if (err) return cb(err)

      getAddressTxs(addrObj.txIds, function (err, txs) {
        if (err) return cb(err)

        addrObj.txs = txs
        cb(null, addrObj)
      })
    })
  }

  function getAddressTxs (txIds, cb) {
    parallel(
      addrObj.txIds.map(function (txId) {
        return db.get.bind(db, prefix.tx + txId, cb)
      }),
      cb
    )
  }

  function getHeight (cb) {
    init(function () {
      cb(null, chainHeight)
    })
  }

  function collectStuff (prefix, cb) {
    collect(db.createReadStream({
      gt: prefix,
      lt: prefix + '\xff'
    }), cb)
  }

  function sync (cb) {
    var oldHeight = chainHeight
    syncHeight(function () {
      if (chainHeight === oldHeight) return cb()

      syncAddresses(watchedAddrs, cb)
    })
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
    parallel(mkBatches(addrs).map(function (batch) {
      return function (cb) {
        runBatch(batch, cb)
      }
    }), cb)
  }

  function runBatch (addrObjs, cb) {
    var addrStrs = addrObjs.map(getProp('address'))
    blockchain.addresses.transactions(addrStrs, addrObjs.minHeight, function (err, txInfos) {
      if (err) return cb(err)

      txInfos = txInfos.map(function (info) {
        return parseTx(info, networkName)
      })

      var txBatch = txInfos.map(function (tx) {
        return {
          type: 'put',
          key: prefix.tx + tx.txId,
          value: tx
        }
      })

      var addrBatch = addrObjs.map(function (addr) {
        return extend(addr, {
          maxBlockHeight: addr.maxBlockHeight,
          txIds: merge(
            getTxsForAddress(txInfos, addr.address),
            addr.txIds
          )
        })
      })
      .filter(function (addr, i) {
        return !deepEqual(addr, addrObjs[i])
      })
      .map(function (addr) {
        return {
          type: 'put',
          key: prefix.address + addr.address,
          value: address
        }
      })

      db.batch(txBatch.concat(addrBatch), cb)
    })
  }

  return {
    watchAddresses: watchAddresses,
    watchedAddresses: getWatchedAddresses,
    address: getAddress,
    addressWithTxs: getAddressWithTxs,
    txs: getTxs,
    sync: sync,
    chainHeight: getHeight
  }
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


function getNonExistant (keys, prefix) {
  parallel(
    keys.map(function (key) {
      return function (cb) {
        db.get(prefix + key, function (err) {
          cb(null, err && err.notFound)
        })
      }
    }),
    function (err, results) {
      if (err) return cb(err)

      cb(null, keys.filter(function (k, i) {
        return results[i]
      }))
    }
  )
}

function storeNew (ids, prefix, newObjFn, cb) {
  getNonExistant(ids, prefix, function (err, newcomers) {
    if (err) return cb(err)

    db.batch(newcomers.map(function (id) {
      return {
        type: 'put',
        key: prefix + id,
        value: newObjFn(id)
      }
    }), cb)
  })
}

function merge (arr, add) {
  arr = arr.concat(add.filter(function (addr) {
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
  var tx = bitcoin.Transaction.fromHex(txInfo.txHex)
  var fromPubKeys = getInputPubKeys(tx)
  return extend(txInfo, {
    from: parseTxSender(tx),
    to: {
      addresses: getOutputAddresses(tx)
    }
  })
}

function parseTxSender (tx) {
  var pubkeys = []
  var addrs = []
  tx.inputs.map(function (input) {
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
  return tx.outputs.map(function (output) {
    return getAddressFromOutput(output, networkName)
  })
  .filter(truthy)
}

// function getInputAddresses (tx, networkName) {
//   return tx.inputs.map(function (input) {
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

function getTxsForAddress (txInfos, addr) {
  return txInfos.filter(function (txInfo) {
    return txInfo.addresses.indexOf(addr) !== -1
  })
  .map(getProp('txId'))
}

function mkBatches (addrObjs) {
  // sort by increasing height
  addrObjs = addrObjs.filter(function (addr) {
    return addr.maxBlockHeight === chainHeight
  })

  addrObjs.sort(function (a, b) {
    return a.maxBlockHeight - b.maxBlockHeight
  })

  var batches = []
  while (addrObjs.length) {
    batches.push(addrObjs.slice(0, BATCH_SIZE))
    addrObjs = addrObjs.slice(BATCH_SIZE)
  }

  var togo = batches.length
  batches.forEach(function (batch) {
    batch.minHeight = batch.reduce(function (min, addr) {
      return Math.min(min, addr.maxBlockHeight)
    }, 1) - 1
  })

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
