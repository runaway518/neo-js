/* eslint handle-callback-err: "off" */
const EventEmitter = require('events')
const _ = require('lodash')
const Logger = require('../common/logger')
const MongodbStorage = require('./storage/mongodb')

/**
 * @class Storage
 * @description
 * A storage class for the various storage methods supported by the neo-js.  This class will
 * include high level storage interface methods that will interface with a standard set of methods available
 * on each type of storage.
 * @param {object} options
 * @param {string} options.model
 * @param {object} options.dataAccessOptions
 * @param {object} options.loggerOptions
 */
class Storage extends EventEmitter {
  /**
   * @fires Storage#constructor:complete
   */
  constructor (options = {}) {
    super()

    // -- Properties
    /** @type {number} */
    this.blockHeight = 0
    /** @type {number} */
    this.index = -1
    /** @type {object} */
    this.dataAccess = undefined
    /** @type {Array} */
    this.unlinkedBlocks = []
    /** @type {Array.<object>} */
    this.assets = []
    /** @type {object} */
    this.logger = undefined
    /** @type {object} */
    this.defaultOptions = {
      model: 'memory',
      updateAssetListIntervalMs: 10000,
      dataAccessOptions: {},
      loggerOptions: {}
    }

    // -- Bootstrap
    Object.assign(this, this.defaultOptions, options)
    this.logger = new Logger('Storage', this.loggerOptions)
    this.initStorage()
    /**
     * @event Storage#constructor:complete
     * @type {object}
     */
    this.emit('constructor:complete')
  }

  /**
   * @private
   * @returns {void}
   */
  initStorage () {
    if (this.model === 'mongoDB') {
      this.dataAccess = new MongodbStorage(this.dataAccessOptions)
      this.initBackgroundTasks()
    } else {
      this.logger.error('Unsupported storage model:', this.model)
    }
  }

  /**
   * @private
   * @returns {void}
   */
  initBackgroundTasks () {
    this.logger.debug('initBackgroundTasks triggered.')
    this.getBlockCount()

    // Periodically update the list of assets available
    this.updateAssetList()
    setInterval(() => {
      this.updateAssetList()
    }, this.updateAssetListIntervalMs)
  }

  /**
   * Gets the balance of all assets and tokens for an address.  This method will return the
   * complete balance sheet for an account unless only a subset of assets is requested.  The
   * method also supports an optional blockAge attribute which will act as a caching mechanism to reduce
   * compute load.
   * @public
   * @param {string} address - A contract address to get the balance of.
   * @param {Array} [assets = node.assets] - An array of the assets to return balances for.
   * @param {number} [blockAge = 1] - getBalance uses a caching mechanic to reduce node load.  If
   * An asset's balance for an account has not been updated withing 'blockAge' blocks, it will retrieve an
   * updated value.  Increasing this number and substantial reduce computer load at the expense
   * of balance discretization.
   * @returns Promise.<Array> An array containing the balances of an address.
   */
  getBalance (address, assets = this.assets, blockAge = 1) {
    this.logger.debug('getBalance triggered. address:', address, 'assets:', assets, 'blockAge:', blockAge)
    // TODO: refactor away usage of assign dynamic data into default input value
    return new Promise((resolve, reject) => {
      this.dataAccess.getAddress(address)
        .then((res) => {
          // If the address is not found in the database, its new...So add it and retry.
          if (!res) {
            this.logger.info('address not found from dataAccess.getAddress(), process to saving it... address:', address)
            this.dataAccess.saveAddress({ address: address, type: 'c', assets: [] })
              .then((res) => {
                this.getBalance(address)
                  .then((res) => {
                    resolve(res)
                  })
              })
              .catch((err) => {
                reject(err)
              })
          } else {
            this.logger.info('address found from dataAccess.getAddress(). address:', address)
            // Sort the assets into 'current' and 'needs update'
            let parts = _.partition(res.assets, (asset) => {
              return (this.index - asset.index) >= blockAge
            })

            // If there is an asset list discrepancy, scan for missing assets to update.
            // This mechanic is used to automatically add new asset support as
            // an asset it appears in a transaction.
            if (res.assets.length !== this.assets.length) {
              let included = _.map(res.assets, 'asset')
              this.assets.forEach((asset) => {
                if (included.indexOf(asset.asset) === -1) {
                  parts[0].push({
                    asset: asset.asset,
                    index: -1,
                    balance: 0
                  })
                }
              })
            }

            // Update stale balances and resolve
            Promise.all(parts[0].map((asset) => {
              return this.getAssetBalance(address, asset.asset, asset.index + 1, asset.balance)
            }))
              .then((res) => {
                resolve({address: address, assets: parts[1].concat(res)})
              })
              .catch((err) => {
                this.logger.warn('Error getting asset balance. Continue...')
                this.logger.info('Error:', err)
              })
          }
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getAddress() execution failed. address:', address)
          reject(err)
        })
    })
  }

  /**
   * Gets the state information of the requested asset.
   * @public
   * @param {string} hash
   * @returns Promise.<object>
   */
  getAssetState (hash) {
    this.logger.debug('getAssetState triggered. hash:', hash)
    return new Promise((resolve, reject) => {
      this.dataAccess.getAsset(hash)
        .then((res) => {
          if (!res) {
            this.logger.info('dataAccess.getAsset() executed but without response data. hash:', hash)
            resolve(undefined)
          }
          resolve(res.state)
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getAsset() execution failed. hash:', hash)
          reject(err)
        })
    })
  }

  /**
   * Returns the requested asset from local storage.
   * @public
   * @param {string} hash
   * @returns Promise.<object>
   */
  getAsset (hash) {
    this.logger.debug('getAsset triggered. hash:', hash)
    return this.dataAccess.getAsset(hash)
  }

  /**
   * Gets the balance of an asset belonging to a specific address
   * on the blockchain.  This method will also cache the result to the
   * addresses collection.
   * @public
   * @param {string} address - The address to find the balance of.
   * @param {string} asset - The asset to look up.
   * @param {number} [startBlock = 0] - the block start start the calculation from.
   * @param {number} [balance = 0] - the balance at the startBlock.
   * @returns Promise.<object> An object containing the asset balance.
   */
  getAssetBalance (address, asset, startBlock = 0, balance = 0) {
    this.logger.debug('getAssetBalance triggered. address:', address, 'asset:', asset, 'startBlock:', startBlock, 'balance:', balance)
    return new Promise((resolve, reject) => {
      this.dataAccess.getAssetListByAddress(address, asset, startBlock)
        .then((res) => {
          Promise.all(_.map(res, 'txid').map(this.getExpandedTX.bind(this)))
            .then((res) => {
              // Balancing
              res.forEach((r) => {
                r.vout.forEach((output) => {
                  if ((output.address === address) && (output.asset === asset)) {
                    balance += output.value
                  }
                })
                r.vin.forEach((input) => {
                  if ((input.address === address) && (input.asset === asset)) {
                    balance -= input.value
                  }
                })
              })

              // Update the address balances in the collection
              const result = { asset: asset, balance: balance, index: this.index, type: 'a' }
              this.dataAccess.updateBalance(address, asset, balance, this.index)
                .then((res) => {
                  resolve(result)
                }) // Not catching errors
            })
            .catch((err) => {
              reject(err)
            })
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getAssetListByAddress() execution failed. address:', address, 'asset:', asset, 'startBlock:', startBlock)
          reject(err)
        })
    })
  }

  /**
   * Returns list of transactions of an asset belonging to a specific address
   * on the blockchain.
   * @public
   * @param {string} address
   * @param {string} assetHash
   * @returns {Promise.<Array>}
   */
  getAssetTransactions (address, assetHash) {
    this.logger.debug('getAssetTransactions triggered. address:', address, 'assetHash:', assetHash)
    return new Promise((resolve, reject) => {
      this.dataAccess.getAssetListByAddress(address, assetHash)
        .then((res) => {
          const transactions = []
          res.forEach((txObj, index) => {
            let subtotal = 0

            txObj.vout.forEach((valueOutObj) => {
              if ((valueOutObj.address === address) && (valueOutObj.asset === assetHash)) {
                subtotal += valueOutObj.value
              }
            })
            txObj.vin.forEach((valueInObj) => {
              if ((valueInObj.address === address) && (valueInObj.asset === assetHash)) {
                subtotal -= valueInObj.value
              }
            })

            const transaction = {
              blockIndex: txObj.blockIndex,
              // blockTime: undefined,
              value: subtotal,
              tx: txObj
            }
            transactions.push(transaction)
          })

          resolve(transactions)
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getAssetListByAddress() execution failed. address:', address, 'assetHash:', assetHash)
          reject(err)
        })
    })
  }

  /**
   * Calculates and returns the expanded transaction.  This method will also
   * update the expanded transaction in local storage to improve later performance.
   * @public
   * @param {string} txid - The '0x' formatted transaction ID.
   * @returns {Promise.<object>} A JSON formatted representation of a transaction.
   */
  getExpandedTX (txid) {
    this.logger.debug('getExpandedTX triggered. txid:', txid)
    return new Promise((resolve, reject) => {
      this.getTX(txid)
        .then((tx) => {
          if (!tx) {
            reject(new Error('Could not find the transaction'))
          }

          // If the tx has already been expanded, return it
          if (tx.vin.some((entry) => _.has(entry, 'asset'))) {
            resolve(tx)
          }

          Promise.all(_.map(tx.vin, 'txid').map(this.getTX.bind(this)))
            .then((res) => {
              tx.vin = _.map(res, (r, i) => (r.vout[tx.vin[i].vout]))
              this.dataAccess.updateTransaction(tx)
                .then((res) => {
                  resolve(tx)
                })
                .catch((err) => { // Despite error, still resolve anyway
                  resolve(tx)
                })
            })
            .catch((err) => {
              this.logger.error('getExpandedTX Promise.all err:', err)
            })
        })
        .catch((err) => {
          this.logger.warn('getTX() execution failed. txid:', txid)
          reject(err)
        })
    })
  }

  /**
   * Returns the JSON formatted transaction from the blockchain.
   * @public
   * @param {string} txid - A '0x' formatted transaction ID.
   * @returns {Promise.<object>} A JSON formatted representation of a transaction.
   */
  getTX (txid) {
    this.logger.debug('getTX triggered. txid:', txid)
    return this.dataAccess.getTX(txid)
  }

  /**
   * Returns the requested block from local storage.
   * @public
   * @param {number} index - The block index being requested.
   * @returns {Promise.<object>} A JSON formatted block on the blockchain.
   */
  getBlock (index) {
    this.logger.debug('getBlock triggered. index:', index)
    return this.dataAccess.getBlock(index)
  }

  /**
   * Returns the requested block from local storage.
   * @public
   * @param {string} hash - The hash of the block being requested.
   * @returns {Promise.<object>} A promise returning information of the block
   */
  getBlockByHash (hash) {
    this.logger.debug('getBlockByHash triggered. hash:', hash)
    return this.dataAccess.getBlockByHash(hash)
  }

  /**
   * Gets the block height of the blockchain maintained in local storage.
   * This method also caches the height and index in memory for use when identifying
   * blocks that need to be downloaded.
   * @public
   * @returns {Promise.<Number>} The block height
   */
  getBlockCount () {
    this.logger.debug('getBlockCount triggered.')
    return new Promise((resolve, reject) => {
      this.dataAccess.getBlockCount()
        .then((res) => {
          this.index = res - 1
          this.blockHeight = res
          resolve(res)
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getBlockCount() execution failed.')
          reject(err)
        })
    })
  }

  /**
   * Gets the best block hash on the node
   * @public
   * @returns {Promise.<object>}
   */
  getBestBlockHash () {
    this.logger.debug('getBestBlockHash triggered.')
    return new Promise((resolve, reject) => {
      this.dataAccess.getBestBlockHash()
        .then((res) => {
          if (!res) {
            this.logger.info('dataAccess.getBestBlockHash() executed but without response data.')
            resolve(undefined)
          }
          resolve(res.hash)
        })
        .catch((err) => {
          this.logger.warn('dataAccess.getBestBlockHash() execution failed.')
          reject(err)
        })
    })
  }

  /**
   * Saves a json formated block to storage. This method will also split out the
   * transactions for storage as well as caching them for later use.
   * @public
   * @param {object} newBlock - The JSON representation of a block on the blockchain.
   * @returns {Promise.<object>}
   */
  saveBlock (newBlock) {
    this.logger.debug('saveBlock triggered.')
    return new Promise((resolve, reject) => {
      this.dataAccess.saveBlock(newBlock)
        .then((res) => {
        // Store the raw transaction
          newBlock.tx.forEach((tx) => {
            tx.blockIndex = newBlock.index
            tx.vout.forEach((d) => {
              if (this.assetsFlat.indexOf(d.asset) === -1) {
                const newAsset = { address: d.asset, asset: d.asset, type: 'a', assets: [] }
                this.assetsFlat.push(d.asset)
                this.assets.push(newAsset)
                this.dataAccess.saveAddress(newAsset)
              }
            })
          })

          Promise.all(_.map(newBlock.tx).map((tx) => {tx.time = newBlock.time; this.dataAccess.saveTransaction(tx);}))
            .then((res) => {
              // Because we asynchronously sync the blockchain,
              // we need to keep track of the blocks that have been stored
              // (higher indices could arrive before the lower ones)
              // This code maintains the local blockheight by tracking
              // 'linked' and 'unlinked'(but stored) blocks
              if (newBlock.index > this.index) {
                this.unlinkedBlocks.push(newBlock.index)
                let linkIndex = -1
                while (true) {
                  linkIndex = this.unlinkedBlocks.indexOf(this.index + 1)
                  if (linkIndex !== -1) {
                    this.unlinkedBlocks.splice(linkIndex, 1)
                    this.index++
                    this.blockHeight++
                  } else break
                }
              }
              resolve(res)
            })
            .catch((err) => reject(err))
        })
        .catch((err) => {
          this.logger.warn('dataAccess.saveBlock() execution failed.')
          reject(err)
        })
    })
  }

  /**
   * Saves the state information of an asset.
   * @public
   * @param {string} hash
   * @param {object} assetState
   * @returns {void}
   */
  saveAssetState (hash, assetState) {
    this.logger.debug('saveAssetState triggered. hash:', hash, 'assetState:', assetState)
    return this.dataAccess.saveAssetState(hash, assetState)
  }

  /**
   * Verifies local blockchain integrity over a block range.
   * @public
   * @param {string} [start = 0] - The start index of the block range to verify.
   * @param {number} [end = this.index] - The end index of the block range to verify.
   * @returns {Promise.<Array>} An array containing the indices of the missing blocks.
   */
  verifyBlocks (start = 0, end = this.index) {
    this.logger.debug('verifyBlocks triggered. start:', start, 'end:', end)
    // TODO: eliminate usage of dynamic default value
    return this.dataAccess.verifyBlocks(start, end)
  }

  /**
   * Verifies local blockchain's asset integrity.
   * @public
   * @returns {Promise.<Array>} An array containing the indices of the invlid assets.
   */
  verifyAssets () {
    this.logger.debug('verifyAssets triggered.')
    return this.dataAccess.verifyAssets()
  }

  /**
   * Returns list of all assets in local storage.
   * @public
   * @returns {Promise.<Array>}
   */
  getAssetList () {
    this.logger.debug('getAssetList triggered.')
    return this.dataAccess.getAssetList()
  }

  /**
   * Caches the list of assets to improve performance of asset related operations.
   * @public
   * @returns {void}
   */
  updateAssetList () {
    this.logger.debug('updateAssetList triggered.')
    this.dataAccess.getAssetList()
      .then((res) => {
        this.assets = res
        this.assetsFlat = _.map(res, 'asset')
      })
      .catch((err) => {
        this.logger.warn('dataAccess.getAssetList() execution failed. continue anyway...')
      })
  }
}

module.exports = Storage
