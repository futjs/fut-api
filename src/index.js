'use strict'

import Promise from 'bluebird'
import assert from 'assert'
import utils from './lib/utils'
import Login from './lib/login'
import MobileLogin from './lib/mobile-login'
import _ from 'underscore'
import Methods from './lib/methods'
import request from 'request'
import bottleneck from 'bottleneck'

let Fut = class Fut extends Methods {
  static isPriceValid = utils.isPriceValid;
  static calculateValidPrice = utils.calculateValidPrice;
  static calculateNextLowerPrice = utils.calculateNextLowerPrice;
  static calculateNextHigherPrice = utils.calculateNextHigherPrice;
  static getBaseId = utils.getBaseId;
  /**
   * [constructor description]
   * @param  {[type]}  options.email          [description]
   * @param  {[type]}  options.password       [description]
   * @param  {[type]}  options.secret         [description]
   * @param  {[type]}  options.platform       [description]
   * @param  {[type]}  options.captchaHandler [description]
   * @param  {[type]}  options.tfAuthHandler  [description]
   * @param  {Boolean} options.saveVariable   [description]
   * @param  {Boolean} options.loadVariable   [description]
   * @param  {Number}  options.RPM            [description]
   * @param  {[String]} options.proxy         [description]
   * @param  {[String]} options.loginType     [description]
   * @return {[type]}                         [description]
   */
  constructor (options) {
    super()
    assert(options.email, 'Email is required')
    assert(options.password, 'Password is required')
    assert(options.secret, 'Secret is required')
    assert(options.platform, 'Platform is required')

    let defaultOptions = {
      RPM: 10,
      loginType: 'web'
    }

    this.options = {}
    this.isReady = false // instance will be ready after we called _init func
    Object.assign(this.options, defaultOptions, options)

    this.limiter = new bottleneck(1, 60000 / this.options.RPM); // Wait time before next request is executed

    if (this.options.loginType === 'web') {
      this.loginLib = Promise.promisifyAll(new Login({proxy: options.proxy}))
    } else if (this.options.loginType === 'mobile') {
      this.loginLib = new MobileLogin({...options, tfCodeHandler: options.tfAuthHandler})
    } else {
      throw new Error(`Unknown loginType ${this.options.loginType}`)
    }
  }

  async loadVariable (key) {
    if (!this.options.loadVariable) return null
    return this.options.loadVariable(key)
  }

  async saveVariable (key, val) {
    if (!this.options.saveVariable) return null
    return this.options.saveVariable(key, val)
  }

  async _init () {
    const cookie = await this.loadVariable('cookie')
    if (cookie) {
      this.loginLib.setCookieJarJSON(cookie)
    }
  }

  async login () {
    await this._init()
    const loginMethod = this.options.loginType === 'web' ? 'loginAsync' : 'login'
    const loginResponse = await this.loginLib[loginMethod](this.options.email, this.options.password, this.options.secret, this.options.platform, this.options.tfAuthHandler, this.options.captchaHandler)

    await this.saveVariable('cookie', this.loginLib.getCookieJarJSON())
    this.rawApi = loginResponse.apiRequest

    const loginDefaults = _.omit(this.loginLib.getLoginDefaults(), 'jar')
    await this.saveVariable('loginDefaults', loginDefaults)
    if (this.options.loginType === 'web') this.rawApi = Promise.promisify(this.rawApi, this)
    this.isReady = true
  }

  async loginCached () {
    const loginDefaults = await this.loadVariable('loginDefaults')
    if (!loginDefaults) {
      throw new Error('Login defaults are not saved. Use classic login first!')
    }
    let rawApi = request.defaults(loginDefaults)
    if (this.options.proxy) {
      rawApi = rawApi.defaults({proxy: this.options.proxy})
    }
    this.rawApi = Promise.promisify(rawApi, this)
    this.isReady = true
  }

  async api (url, options) {
    if (!this.isReady) throw new Error('Fut instance is not ready yet, run login first!')

    const defaultOptions = {
      xHttpMethod: 'GET',
      headers: {}
    }

    options = _.extend(defaultOptions, options)
    options.url = url
    options.method = 'POST'

    options.headers['X-HTTP-Method-Override'] = options.xHttpMethod
    delete options.xHttpMethod

    let apiResponse;
    if(options.overrideLimiter) {
      apiResponse = await this.rawApi(options)
    } else {
      apiResponse = await this.limiter.schedule(this.rawApi, options)
    }

    const {statusCode, statusMessage, body} = apiResponse

    if (statusCode.toString()[0] !== '2') {
      const request = {url, options: options}
      throw new Error(`FUT api http error: ${statusCode} ${statusMessage} ${JSON.stringify(body)} request was: ${JSON.stringify(request)}`)
    }

    if (utils.isApiError(body)) {
      body.request = {url, options: options}
      const err = new Error(`Fut api error: ${JSON.stringify(body)}`)
      err.futApiStatusCode = Number(body.code)
      throw err
    }
    return body
  }
}

module.exports = Fut