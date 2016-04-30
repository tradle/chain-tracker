
var test = require('tape')
var levelup = require('levelup')
var memdown = require('memdown')
var uniq = require('uniq')
var tracker = require('../')
var NETWORK_NAME = 'testnet'
var DB_COUNTER = 0
var allTxs = require('./fixtures').transactions.sort(function (a, b) {
  return a.blockHeight - b.blockHeight
})

var parsedTxs = allTxs.map(function (txInfo) {
  return tracker.parseTx(txInfo, NETWORK_NAME)
})

// var heights = {}
// var allAddrs = parsedTxs.map(function (parsed) {
//   var addrs = uniq(parsed.from.addresses.concat(parsed.to.addresses))
//   addrs.forEach(function (addr) {
//     heights[addr] = heights[addr] || {}
//     heights[addr][parsed.blockHeight] = (heights[addr][parsed.blockHeight] || 0) + 1
//   })

//   return addrs
// })
// .reduce(function (arr, next) {
//   return arr.concat(next)
// })
// .sort()

// console.log(heights)

// var counter = allAddrs.length
// while (counter-- > 1) {
//   if (allAddrs[counter] === allAddrs[counter - 1]) {
//     allAddrs.splice(counter, 1)
//   }
// }

// console.log(allAddrs)

test('parseTx', function (t) {
  var txInfo = allTxs[0]
  var parsed = tracker.parseTx(txInfo, NETWORK_NAME)
  t.same(parsed.from.pubkeys, [new Buffer('040cfa3dfb357bdff37c8748c7771e173453da5d7caa32972ab2f5c888fff5bbaeb5fc812b473bf808206930fade81ef4e373e60039886b51022ce68902d96ef70', 'hex')])
  t.same(parsed.from.addresses, ['mpRZxxp5FtmQipEWJPa1NY9FmPsva3exUd'])
  t.same(parsed.to.addresses, ['mvwvsPT2J3VPEaYmFdExFc4iBGRRK2Vdkd', 'mpRZxxp5FtmQipEWJPa1NY9FmPsva3exUd'])
  t.end()
})

test('mkBatches', function (t) {
  // test 1
  var addrObjs = [{
    address: 'abc',
    maxBlockHeight: 1
  }]

  var expected = [addrObjs.slice()]
  var batches = tracker.mkBatches(addrObjs, 10)
  t.same(batches, expected)

  // test 2
  addrObjs.length = 0
  for (var i = 0; i < 100; i++) {
    addrObjs.push({
      address: 'abc' + i,
      maxBlockHeight: 100 - i - 1
    })
  }

  var batchSize = 50
  var chainHeight = 70
  var sorted = addrObjs.slice().sort(byHeight)
  var expected = [
    sorted.slice(0, batchSize),
    sorted.slice(batchSize, chainHeight)
  ]

  var batches = tracker.mkBatches(addrObjs, chainHeight, batchSize)
  t.same(batches, expected)

  t.end()
})

test('tracker', function (t) {
  var db = newDB()
  var chain = fakechain()
  // var txMethod = chain.addresses.transactions
  // var confirmationsTillConfirmed = 1
  // var started
  // chain.addresses.transactions = function (addrs, blockHeight, cb) {
  //   txMethod.call(chain.addresses, addrs, blockHeight, function (err, results) {
  //     if (started) {
  //       t.equal(blockHeight, chain._height() - confirmationsTillConfirmed)
  //     } else {
  //       started = true
  //     }

  //     cb(err, results)
  //   })
  // }

  var tr = tracker({
    db: db,
    blockchain: chain,
    networkName: NETWORK_NAME,
    confirmedAfter: 1
  })

  var addr1 = 'mucvYPyF36YUbjVd3UzZaxrtU4LhJzf8fs'
  var addr2 = 'mgeE9pVPySyFCnTNsytF6zgJRxWmpoFdxu'
  tr.watchAddresses([addr1])
  tr.sync(function (err) {
    if (err) throw err

    tr.getTxs(addr1, function (err, results) {
      if (err) throw err

      t.equal(results.length, 0)
    })

    chain._setHeight(314755)
    tr.sync(function (err) {
      if (err) throw err

      tr.getTxs(addr1, function (err, results) {
        if (err) throw err

        t.equal(results.length, 2)
        chain._setHeight(314759)
        tr.sync(function (err) {
          if (err) throw err

          tr.getTxs(addr1, function (err, results) {
            if (err) throw err

            t.equal(results.length, 6)
            chain._setHeight(314784)
            tr.sync(function (err) {
              if (err) throw err

              tr.getTxs(addr1, function (err, results) {
                if (err) throw err

                t.equal(results.length, 7)
                tr.watchAddresses([addr2])
                tr.sync(function (err) {
                  if (err) throw err

                  tr.getTxs(addr2, function (err, results) {
                    if (err) throw err

                    t.equal(results.length, 3)
                    t.end()
                  })
                })
              })
            })
          })
        })
      })
    })
  })
})

function byHeight (a, b) {
  return a.maxBlockHeight - b.maxBlockHeight
}

function fakechain () {
  var currentHeight
  var txInfos = []
  var parsed = []
  setHeight(0)

  return {
    addresses: {
      transactions: function (addrs, blockHeight, cb) {
        process.nextTick(function () {
          var results = []
          parsed.forEach(function (txInfo, i) {
            if (txInfo.blockHeight >= blockHeight &&
              addrs.some(function (addr) {
                return txInfo.from.addresses.indexOf(addr) !== -1 ||
                  txInfo.to.addresses.indexOf(addr) !== -1
              })) {
              results.push(txInfos[i])
            }
          })

          cb(null, results)
        })
      }
    },
    blocks: {
      latest: function (cb) {
        process.nextTick(function () {
          cb(null, {
            blockHeight: currentHeight
          })
        })
      }
    },
    _setHeight: setHeight,
    _height: function () {
      return currentHeight
    }
  }

  function setHeight (height) {
    if (currentHeight && height < currentHeight) {
      throw new Error('this blockchain only goes forwards')
    }

    currentHeight = height
    txInfos = []
    parsed = []
    allTxs.forEach(function (txInfo, i) {
      if (txInfo.blockHeight <= height) {
        txInfos.push(allTxs[i])
        parsed.push(parsedTxs[i])
      }
    })
  }
}

function newDB () {
  return levelup('blah' + (DB_COUNTER++), { db: memdown, valueEncoding: 'json' })
}
