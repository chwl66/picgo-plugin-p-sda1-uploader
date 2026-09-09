// PicGo 插件：p-sda1-uploader
// 用于将图片上传到 p.sda1.dev 图床服务

const path = require('path')
const { version: PACKAGE_VERSION } = require('./package.json')

const UPLOAD_CONFIG = {
  API_URL: 'https://p.sda1.dev/api/v1/upload_external_noform',
  ALLOWED_HOSTS: new Set(['p.sda1.dev']),
  TIMEOUT: 30000,
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  MAX_CONCURRENCY: 3,
  MAX_FILENAME_LENGTH: 128
}

const EXTENSION_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE'
])

// 请求体可能已经送达图床、只是响应没回来的错误（超时、连接中途断开）。
// 这类错误重试成功时，上一次尝试也可能已经存了一份，需要提示用户核对重复文件；
// 而 DNS 失败、连接被拒、网络不可达发生在建连阶段，可以直接排除落盘可能
const MAY_BE_STORED_ERROR_KEYWORDS = [
  'timeout',
  'timed out',
  'socket hang up',
  'connection reset',
  'econnreset',
  'epipe',
  'etimedout',
  'esockettimedout',
  'econnaborted'
]

const RETRYABLE_ERROR_MESSAGE_KEYWORDS = [
  'timeout',
  'timed out',
  'network',
  'socket hang up',
  'connection reset'
]

// delete_url 等价于"拿到就能删图"的凭证，PicGo 的日志文件是明文，
// 因此所有会把响应内容写进日志/通知的地方都必须先过一遍脱敏
const SECRET_FIELD_PATTERN = /(["']?delete[_-]?urls?["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi

const redactSecrets = (value) => String(value).replace(SECRET_FIELD_PATTERN, '$1***')

module.exports = (ctx) => {
  const getMimeTypeFromExt = (extname) => {
    if (!extname || typeof extname !== 'string') {
      return null
    }

    const normalizedExt = extname.startsWith('.')
      ? extname.toLowerCase()
      : `.${extname.toLowerCase()}`
    return EXTENSION_TO_MIME[normalizedExt] || null
  }

  const getMimeTypeFromFileName = (fileName) => {
    if (!fileName || typeof fileName !== 'string') {
      return null
    }

    const dotIndex = fileName.lastIndexOf('.')
    if (dotIndex === -1) {
      return null
    }

    return getMimeTypeFromExt(fileName.slice(dotIndex))
  }

  const detectMimeTypeFromBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
      return null
    }

    // JPEG
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg'
    }

    // PNG
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'image/png'
    }

    // GIF
    if (
      buffer.length >= 6 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61
    ) {
      return 'image/gif'
    }

    // WebP: RIFF....WEBP
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp'
    }

    return null
  }

  const extractBase64Payload = (base64Image) => {
    if (typeof base64Image !== 'string') {
      throw new Error('base64 数据格式无效')
    }

    const raw = base64Image.trim()
    if (!raw) {
      throw new Error('base64 数据为空')
    }

    const dataUrlMatch = raw.match(/^data:([^;]+);base64,([\s\S]+)$/i)
    const mimeType = dataUrlMatch?.[1]?.toLowerCase() || null
    const payload = (dataUrlMatch?.[2] || raw)
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')

    if (!payload) {
      throw new Error('base64 数据为空')
    }

    if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
      throw new Error('base64 数据包含非法字符')
    }

    return { mimeType, payload }
  }

  const inferMimeType = (img, dataUrlMimeType, buffer) => {
    const magicMime = detectMimeTypeFromBuffer(buffer)
    if (magicMime) {
      return magicMime
    }

    if (dataUrlMimeType) {
      return dataUrlMimeType
    }

    const mimeFromImg = [img.type, img.mimeType, img.mimetype]
      .find(value => typeof value === 'string' && value.includes('/'))
    if (mimeFromImg) {
      return mimeFromImg.toLowerCase()
    }

    return getMimeTypeFromExt(img.extname) || getMimeTypeFromFileName(img.fileName)
  }

  const sanitizeFileName = (fileName, fallbackExt = '.png') => {
    const rawName = typeof fileName === 'string' && fileName.trim()
      ? fileName.trim()
      : `picgo-upload-${Date.now()}-${Math.random().toString(36).slice(2, 11)}${fallbackExt}`

    let base = path.basename(rawName).replace(/[^\w.\-]+/g, '_')
    if (!base || base === '.' || base === '..') {
      base = `picgo-upload-${Date.now()}${fallbackExt}`
    }

    if (base.length > UPLOAD_CONFIG.MAX_FILENAME_LENGTH) {
      const ext = path.extname(base).slice(0, 16)
      const nameBody = base.slice(0, UPLOAD_CONFIG.MAX_FILENAME_LENGTH - ext.length)
      base = `${nameBody}${ext}`
    }

    return base
  }

  const readErrorStatusCode = (error) => {
    const candidates = [
      error?.statusCode,
      error?.status,
      error?.response?.statusCode,
      error?.response?.status
    ]

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate
      }

      if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
        return Number(candidate)
      }
    }

    return null
  }

  // PicGo 核心（2.x/3.x 实测一致）把超时、DNS 失败、连接被拒等「没拿到响应」的错误
  // 统一成 statusCode: 0 且不携带 error.code，因此 0 不能当作 HTTP 状态码返回，
  // 否则调用方会把它当成一次合法响应而跳过传输层的重试判断
  const getErrorStatusCode = (error) => {
    const statusCode = readErrorStatusCode(error)
    return statusCode !== null && statusCode >= 100 ? statusCode : null
  }

  const isNetworkLevelError = (error) => {
    if (readErrorStatusCode(error) === 0) {
      return true
    }

    const code = error?.code
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code.toUpperCase())) {
      return true
    }

    const message = (error?.message || '').toLowerCase()

    // 部分运行环境只把 errno 留在 message 里（如 "connect ECONNREFUSED 127.0.0.1:443"）
    if (Array.from(RETRYABLE_ERROR_CODES).some(code => message.includes(code.toLowerCase()))) {
      return true
    }

    return RETRYABLE_ERROR_MESSAGE_KEYWORDS.some(keyword => message.includes(keyword))
  }

  const isRetryableError = (error) => {
    const statusCode = getErrorStatusCode(error)

    if (statusCode !== null) {
      return statusCode === 429 || statusCode >= 500
    }

    return isNetworkLevelError(error)
  }

  /**
   * 判断"文件可能已被图床收下、只是响应丢失"，用于标记重复文件风险
   * @param {Error} error - 请求错误（仅在请求本身失败时传入）
   * @returns {boolean} 是否可能已落盘
   */
  const mayBeStoredOnHost = (error) => {
    // 拿到 HTTP 响应说明请求完整送达且服务端已明确表态，不存在静默落盘
    if (getErrorStatusCode(error) !== null) {
      return false
    }

    const haystack = `${error?.code || ''} ${error?.message || ''}`.toLowerCase()
    return MAY_BE_STORED_ERROR_KEYWORDS.some(keyword => haystack.includes(keyword))
  }

  const formatErrorForLog = (error) => {
    const message = error?.message || 'unknown error'
    const statusCode = getErrorStatusCode(error)
    const code = error?.code

    if (statusCode !== null && code) {
      return `${message} (status: ${statusCode}, code: ${code})`
    }

    if (statusCode !== null) {
      return `${message} (status: ${statusCode})`
    }

    if (code) {
      return `${message} (code: ${code})`
    }

    return message
  }

  const validateReturnedUrl = (url, fieldName) => {
    if (url == null || url === '') {
      return null
    }

    if (typeof url !== 'string') {
      throw new Error(`${fieldName} 类型无效`)
    }

    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      throw new Error(`${fieldName} 不是合法 URL`)
    }

    if (parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} 必须使用 https 协议`)
    }

    if (!UPLOAD_CONFIG.ALLOWED_HOSTS.has(parsed.hostname)) {
      throw new Error(`${fieldName} 主机不在允许列表中: ${parsed.hostname}`)
    }

    return url
  }

  /**
   * 验证图片数据
   * @param {Object} img - 图片对象
   * @returns {string|null} 验证失败的原因，通过时返回 null
   */
  const validateImage = (img) => {
    const displayName = img.fileName || 'unknown'

    if (!img.buffer && !img.base64Image) {
      const reason = `图片 ${displayName} 缺少数据`
      ctx.log.error(reason)
      return reason
    }

    let dataUrlMimeType = null

    if (!img.buffer && img.base64Image) {
      try {
        const { mimeType, payload } = extractBase64Payload(img.base64Image)
        dataUrlMimeType = mimeType
        img.buffer = Buffer.from(payload, 'base64')

        if (!img.buffer.length) {
          throw new Error('base64 转换后数据为空')
        }
      } catch (error) {
        const reason = `图片 ${displayName} base64 转换失败: ${error.message}`
        ctx.log.error(reason)
        return reason
      }
    }

    if (!Buffer.isBuffer(img.buffer)) {
      const reason = `图片 ${displayName} 数据格式无效`
      ctx.log.error(reason)
      return reason
    }

    if (img.buffer.length === 0) {
      const reason = `图片 ${displayName} 数据为空`
      ctx.log.error(reason)
      return reason
    }

    if (img.buffer.length > UPLOAD_CONFIG.MAX_FILE_SIZE) {
      const reason =
        `图片 ${displayName} 超过大小限制 (${UPLOAD_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`
      ctx.log.error(reason)
      return reason
    }

    const magicMime = detectMimeTypeFromBuffer(img.buffer)
    if (!magicMime || !UPLOAD_CONFIG.SUPPORTED_TYPES.includes(magicMime)) {
      // 魔数无法识别时不再信任扩展名，避免伪装成图片
      const declaredMime = inferMimeType(img, dataUrlMimeType, img.buffer)
      const reason =
        `图片 ${displayName} 类型不支持或无法识别: magic=${magicMime || 'unknown'}, declared=${declaredMime || 'unknown'}`
      ctx.log.error(reason)
      return reason
    }

    return null
  }

  /**
   * 解析服务器响应
   * @param {*} response - 服务器响应
   * @returns {Object} 解析后的结果
   */
  const parseResponse = (response) => {
    let resObj = response

    if (typeof response === 'string') {
      try {
        resObj = JSON.parse(response)
      } catch (error) {
        throw new Error(`服务器返回格式错误: ${redactSecrets(response.substring(0, 100))}`)
      }
    }

    let url
    let deleteUrl
    if (resObj?.data?.url) {
      url = resObj.data.url
      deleteUrl = resObj.data.delete_url
    } else if (resObj?.url) {
      url = resObj.url
      deleteUrl = resObj.delete_url
    }

    if (!url) {
      const preview = typeof resObj === 'object'
        ? redactSecrets(JSON.stringify(resObj).slice(0, 200))
        : redactSecrets(String(resObj).slice(0, 200))
      throw new Error(`服务器未返回有效地址: ${preview}`)
    }

    url = validateReturnedUrl(url, 'url')
    deleteUrl = deleteUrl ? validateReturnedUrl(deleteUrl, 'delete_url') : deleteUrl

    return { url, deleteUrl }
  }

  /**
   * 延迟函数
   * @param {number} ms - 延迟毫秒数
   */
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * 上传单张图片（带可恢复错误重试）
   * @param {Object} img - 图片对象
   * @param {number} retryCount - 已重试次数
   * @param {boolean} duplicateRisk - 此前是否出现过"响应丢失"型错误
   * @returns {Promise<Object>} 上传结果
   */
  const uploadSingleImage = async (img, retryCount = 0, duplicateRisk = false) => {
    const fileName = sanitizeFileName(img.fileName)
    let requestSettled = false

    try {
      const response = await ctx.request({
        method: 'POST',
        url: UPLOAD_CONFIG.API_URL,
        headers: {
          'Content-Type': 'application/octet-stream',
          'User-Agent': `PicGo-Plugin-p-sda1-uploader/${PACKAGE_VERSION}`
        },
        params: { filename: fileName },
        body: img.buffer,
        timeout: UPLOAD_CONFIG.TIMEOUT
      })
      requestSettled = true

      const responsePreview = typeof response === 'string'
        ? redactSecrets(response.slice(0, 200))
        : redactSecrets(JSON.stringify(response).slice(0, 200))
      ctx.log.debug(`p.sda1.dev 响应 (${fileName}): ${responsePreview}`)

      const { url, deleteUrl } = parseResponse(response)

      return {
        success: true,
        url,
        deleteUrl,
        fileName,
        duplicateRisk
      }
    } catch (error) {
      const detail = formatErrorForLog(error)
      const errorMsg = `上传失败 (${fileName}): ${detail}`
      const shouldRetry = retryCount < UPLOAD_CONFIG.MAX_RETRIES && isRetryableError(error)

      // 请求本身失败才可能"已落盘但响应丢失"；请求成功后的解析/校验异常另当别论
      const currentRisk = requestSettled ? false : mayBeStoredOnHost(error)
      const carriedRisk = duplicateRisk || currentRisk

      if (shouldRetry) {
        ctx.log.warn(`${errorMsg}, 准备重试 (${retryCount + 1}/${UPLOAD_CONFIG.MAX_RETRIES})`)
        await delay(UPLOAD_CONFIG.RETRY_DELAY * (retryCount + 1))
        return uploadSingleImage(img, retryCount + 1, carriedRisk)
      }

      ctx.log.error(
        `${errorMsg}, ${retryCount >= UPLOAD_CONFIG.MAX_RETRIES ? '已达到最大重试次数' : '错误不可重试'}`
      )
      return {
        success: false,
        error: detail,
        fileName,
        duplicateRisk: carriedRisk
      }
    }
  }

  const processSingleImage = async (img, index, imgList, results) => {
    try {
      const validationError = validateImage(img)
      if (validationError) {
        results.failed.push({
          index,
          fileName: img.fileName || `image-${index}`,
          error: validationError
        })
        return
      }

      const result = await uploadSingleImage(img)

      if (result.success) {
        // PicGo 规范：imgUrl 必填；url 供剪贴板优先使用
        img.imgUrl = result.url
        img.url = result.url
        img.deleteUrl = result.deleteUrl
        // 成功后释放本地数据，降低内存占用（官方/内置 uploader 惯例）
        delete img.buffer
        delete img.base64Image
        results.success.push({
          index,
          fileName: result.fileName,
          url: result.url
        })
        ctx.log.info(`上传成功 (${index + 1}/${imgList.length}): ${result.url}`)

        if (result.duplicateRisk) {
          results.duplicateRisk.push({ index, fileName: result.fileName, recovered: true })
          ctx.log.warn(
            `上传成功 (${result.fileName})，但重试前出现过响应丢失型网络错误，图床可能残留一份重复文件`
          )
        }
      } else {
        results.failed.push({
          index,
          fileName: result.fileName,
          error: result.error
        })

        if (result.duplicateRisk) {
          results.duplicateRisk.push({ index, fileName: result.fileName, recovered: false })
        }
      }
    } catch (error) {
      results.failed.push({
        index,
        fileName: img.fileName || `image-${index}`,
        error: error.message
      })
      ctx.log.error(`处理图片失败 (${index + 1}/${imgList.length}): ${error.message}`)
    }
  }

  /**
   * 批量上传图片（有限并发）
   * @param {Array} imgList - 图片列表
   * @returns {Promise<Object>} 上传结果统计
   */
  const uploadImages = async (imgList) => {
    const results = {
      success: [],
      failed: [],
      duplicateRisk: [],
      total: imgList.length
    }

    const concurrency = Math.max(1, Math.min(UPLOAD_CONFIG.MAX_CONCURRENCY, imgList.length))
    let cursor = 0

    const worker = async () => {
      while (true) {
        const currentIndex = cursor
        cursor += 1

        if (currentIndex >= imgList.length) {
          return
        }

        await processSingleImage(imgList[currentIndex], currentIndex, imgList, results)
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return results
  }

  const notify = (runtimeCtx, title, body) => {
    try {
      runtimeCtx.emit('notification', {
        title,
        body: body || '',
        text: ''
      })
    } catch (error) {
      // 部分运行环境可能不支持 notification，忽略即可
      runtimeCtx.log?.debug?.(`发送通知失败: ${error.message}`)
    }
  }

  const register = () => {
    ctx.helper.uploader.register('p-sda1-uploader', {
      name: '流浪图床',
      handle: async function (ctx) {
        const imgList = ctx.output

        if (!imgList || imgList.length === 0) {
          ctx.log.warn('没有图片需要上传')
          return ctx
        }

        ctx.log.info(`开始上传 ${imgList.length} 张图片到 p.sda1.dev`)

        try {
          const results = await uploadImages(imgList)

          ctx.log.info(
            `上传完成: 成功 ${results.success.length}/${results.total}, 失败 ${results.failed.length}/${results.total}`
          )

          if (results.failed.length > 0) {
            ctx.log.warn('失败的图片:')
            results.failed.forEach(fail => {
              ctx.log.warn(`  - ${fail.fileName}: ${fail.error}`)
            })

            // 仅保留上传成功的项，避免 GUI/剪贴板输出空链接
            const failedIndexSet = new Set(results.failed.map(item => item.index))
            ctx.output = imgList.filter((_, index) => !failedIndexSet.has(index))
          }

          // 重试期间出现过"响应丢失"型错误：图床可能已经存下我们无法记录的副本
          if (results.duplicateRisk.length > 0) {
            const detail = results.duplicateRisk
              .slice(0, 3)
              .map(item => item.fileName)
              .join('、')
            const unrecovered = results.duplicateRisk.filter(item => !item.recovered).length

            ctx.log.warn(
              `以下图片可能因响应丢失而在图床留下重复文件: ${detail}` +
              (unrecovered > 0 ? `（其中 ${unrecovered} 张最终未上传成功，需手动核对）` : '')
            )
            notify(
              ctx,
              '流浪图床可能存在重复文件',
              `重试期间连接中断，图床可能已存下无法自动删除的副本，请核对：${detail}`
            )
          }

          if (results.success.length === 0) {
            const detail = results.failed
              .slice(0, 3)
              .map(item => `${item.fileName}: ${item.error}`)
              .join('；')
            // 原因直接进异常信息：固定提示"请检查网络连接"会把类型不支持、体积超限这类
            // 本地校验失败误导成网络问题
            const message = `所有图片上传失败：${detail || '未知原因'}`
            notify(ctx, '流浪图床上传失败', detail || message)
            throw new Error(message)
          }

          if (results.failed.length > 0) {
            notify(
              ctx,
              '流浪图床部分上传失败',
              `成功 ${results.success.length}/${results.total}，失败 ${results.failed.length}`
            )
          }
        } catch (error) {
          ctx.log.error(`批量上传过程出错: ${error.message}`)
          if (!String(error.message || '').includes('所有图片上传失败')) {
            notify(ctx, '流浪图床上传失败', error.message || '未知错误')
          }
          throw error
        }

        return ctx
      },
      // 图床级配置：当前无需用户填写，返回空数组即可
      config: () => []
    })
  }

  // 插件级配置（存储于完整包名下）；本插件无额外配置
  const config = () => []

  return {
    name: 'p-sda1-uploader',
    // 官方推荐：声明本插件提供的 uploader id，便于发现与设为当前图床
    uploader: 'p-sda1-uploader',
    register,
    config
  }
}
