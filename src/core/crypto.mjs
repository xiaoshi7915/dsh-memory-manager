/**
 * AES-256-GCM 本地加密：主密码经 scrypt 派生密钥；无主密码时随机密钥文件。
 * @module src/core/crypto
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MemoryError } from './types.mjs'

const ALGO = 'aes-256-gcm'

export class MemoryCrypto {
  /**
   * @param {{enabled?: boolean, masterPassword?: string, saltFile?: string, keyFile?: string}} opts
   */
  constructor({ enabled = true, masterPassword = '', saltFile, keyFile } = {}) {
    this.enabled = enabled
    this.masterPassword = masterPassword
    this.saltFile = saltFile
    this.keyFile = keyFile
    this.key = null
    this.mode = 'none'
  }

  async init() {
    if (!this.enabled) return
    if (this.masterPassword) {
      await fsp.mkdir(path.dirname(this.saltFile), { recursive: true })
      let salt
      if (fs.existsSync(this.saltFile)) {
        salt = fs.readFileSync(this.saltFile)
      } else {
        salt = crypto.randomBytes(16)
        await fsp.writeFile(this.saltFile, salt, { mode: 0o600 })
      }
      this.key = crypto.scryptSync(this.masterPassword, salt, 32)
      this.mode = 'scrypt'
    } else {
      await fsp.mkdir(path.dirname(this.keyFile), { recursive: true })
      let key
      if (fs.existsSync(this.keyFile)) {
        key = fs.readFileSync(this.keyFile)
      } else {
        key = crypto.randomBytes(32)
        await fsp.writeFile(this.keyFile, key, { mode: 0o600 })
      }
      this.key = key
      this.mode = 'random'
    }
  }

  active() {
    return this.enabled && this.key !== null
  }

  fingerprint() {
    return this.enabled ? this.mode : 'none'
  }

  /** 加密为 base64(iv.tag.ct)。 */
  encrypt(plain) {
    if (!this.active()) return plain
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(ALGO, this.key, iv)
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ct]).toString('base64')
  }

  /** 解密 base64(iv.tag.ct)。 */
  decrypt(cipher) {
    if (!this.active()) return cipher
    try {
      const buf = Buffer.from(cipher, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const ct = buf.subarray(28)
      const decipher = crypto.createDecipheriv(ALGO, this.key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      throw new MemoryError('DECRYPTION_FAILED', '记忆内容解密失败：密钥可能已变更，请检查主密码配置')
    }
  }
}
