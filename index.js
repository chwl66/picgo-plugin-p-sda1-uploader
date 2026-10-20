// PicGo 插件：p-sda1-uploader
// 用于将图片上传到 p.sda1.dev 图床服务
//
// 接口契约以图床官方 ShareX 配置（https://p.sda1.dev/p.sda1.dev.sxcu）为准：
//   POST https://p.sda1.dev/api/v1/upload_external_noform?filename=<name>
//   Body: Binary（Content-Type: application/octet-stream）
//   取回 data.url / data.delete_url

const path = require('path')
const { version: PACKAGE_VERSION } = require('./package.json')

const UPLOAD_CONFIG = {
  API_URL: 'https://p.sda1.dev/api/v1/upload_external_noform',
  ALLOWED_HOSTS: new Set(['p.sda1.dev']),
  TIMEOUT: 30000,
  // 图床硬限制 5MiB：超出时返回 500 {"success":false,"message":"The file to upload cannot be larger than 5MiB."}
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  MAX_CONCURRENCY: 3,
  MAX_FILENAME_LENGTH: 128
}

// 图床接受任意 Unicode 文件名（2026-10 实测：中文名可上传，返回的 URL 直接访问返回 200），
// 但文件名会被原样拼进 URL，所以只中和"会破坏链接/路径"的字符，中文等可读字符保留。
// 注意：空白必须替换——返回的 URL 里空格不会被编码，Markdown 链接会在这里断掉
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f\s\\/:*?"<>|#%&'()\[\]{}]/g

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

// 每次调用都 Array.from 会重建数组，这里预计算
const RETRYABLE_ERROR_CODE_LIST = Array.from(RETRYABLE_ERROR_CODES)

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

// 比上面更宽：只用来判断"值得再试一次"，不承担落盘推断
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
  const detectMimeTypeFromBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
      return null
    }

    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
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

    // BMP: "BM"。官网前端 allowedFileExtensions 也包含 bmp，图床侧实测同样接受
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return 'image/bmp'
    }

    return null
  }

  const decodeBase64Image = (base64Image) => {
    if (typeof base64Image !== 'string') {
      throw new Error('base64 数据格式无效')
    }

    const raw = base64Image.trim()
    if (!raw) {
      throw new Error('base64 数据为空')
    }

    // 兼容 data URL 前缀与 URL-safe base64
    const dataUrlMatch = raw.match(/^data:[^;]+;base64,([\s\S]+)$/i)
    const payload = (dataUrlMatch?.[1] || raw)
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')

    if (!payload) {
      throw new Error('base64 数据为空')
    }

    if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
      throw new Error('base64 数据包含非法字符')
    }

    return Buffer.from(payload, 'base64')
  }

  const sanitizeFileName = (fileName, fallbackExt = '.png') => {
    const fallback = `picgo-upload-${Date.now()}-${Math.random().toString(36).slice(2, 11)}${fallbackExt}`
    const rawName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : fallback

    // path.basename 去掉路径穿越；normalize 让同一个字的组合形式保持一致
    let base = path.basename(rawName).normalize('NFC').replace(UNSAFE_FILENAME_CHARS, '_')

    // 纯点号（. / .. / ...）没有意义；结尾的点与空格会被部分环境吞掉
    if (/^\.*$/.test(base)) {
      base = ''
    } else {
      base = base.replace(/[. ]+$/, '')
    }

    if (!base) {
      base = fallback
    }

    if (base.length > UPLOAD_CONFIG.MAX_FILENAME_LENGTH) {
      const ext = path.extname(base).slice(0, 16)
      const nameBody = base.slice(0, Math.max(1, UPLOAD_CONFIG.MAX_FILENAME_LENGTH - ext.length))
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

  // PicGo 2.x 把响应体放在 error.response.body，3.x（axios）放在 error.response.data，
  // 两边都可能是字符串或已解析的对象；取第一个非空值
  const readErrorResponseBody = (error) => {
    const body = [error?.response?.body, error?.response?.data]
      .find(candidate => candidate != null && candidate !== '')

    if (body == null) {
      return null
    }

    if (typeof body === 'object') {
      return body
    }

    if (typeof body !== 'string') {
      return null
    }

    const text = body.trim()
    if (!text) {
      return null
    }

    try {
      return JSON.parse(text)
    } catch (parseError) {
      return null
    }
  }

  /**
   * 识别图床的"业务拒绝"
   *
   * 图床把所有业务错误都表达成 HTTP 500 + {"success":false,"code":"error","message":"..."}
   * （实测：超过 5MiB 返回 "The file to upload cannot be larger than 5MiB."）。
   * 这种响应意味着服务端已经完整读过请求并明确拒绝，重发同样的字节不会有不同结果，
   * 因此必须按不可重试处理；同时要把服务端的 message 透出来——只报 "status code 500"
   * 会把真实原因（超限、内容被拒等）彻底吞掉。
   *
   * @param {Error} error - 请求错误
   * @returns {{message: string|null}|null} 业务拒绝时返回对象，否则 null
   */
  const inspectServerRejection = (error) => {
    if (getErrorStatusCode(error) === null) {
      return null
    }

    const body = readErrorResponseBody(error)
    if (!body || typeof body !== 'object') {
      return null
    }

    // 只认图床自己的错误约定；{"code":500} 这类通用响应仍按服务器故障重试
    if (body.success !== false && body.code !== 'error') {
      return null
    }

    const message = typeof body.message === 'string' ? body.message.trim() : ''
    return { message: message ? redactSecrets(message) : null }
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
    if (RETRYABLE_ERROR_CODE_LIST.some(code => message.includes(code.toLowerCase()))) {
      return true
    }

    return RETRYABLE_ERROR_MESSAGE_KEYWORDS.some(keyword => message.includes(keyword))
  }

  const isRetryableError = (error) => {
    const statusCode = getErrorStatusCode(error)

    if (statusCode !== null) {
      // 业务拒绝是确定性的，重试只会拖长失败时间
      if (inspectServerRejection(error)) {
        return false
      }

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
    const serverMessage = inspectServerRejection(error)?.message
    const details = []

    if (statusCode !== null) {
      details.push(`status: ${statusCode}`)
    }

    if (code) {
      details.push(`code: ${code}`)
    }

    // 图床的真实原因（如超过 5MiB）只存在于响应体里，必须带出来
    if (serverMessage) {
      details.push(`server: ${serverMessage}`)
    }

    return details.length > 0 ? `${message} (${details.join(', ')})` : message
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

    const reject = (reason) => {
      ctx.log.error(reason)
      return reason
    }

    if (!img.buffer && !img.base64Image) {
      return reject(`图片 ${displayName} 缺少数据`)
    }

    if (!img.buffer) {
      try {
        img.buffer = decodeBase64Image(img.base64Image)

        if (!img.buffer.length) {
          throw new Error('base64 转换后数据为空')
        }
      } catch (error) {
        return reject(`图片 ${displayName} base64 转换失败: ${error.message}`)
      }
    }

    if (!Buffer.isBuffer(img.buffer)) {
      return reject(`图片 ${displayName} 数据格式无效`)
    }

    if (img.buffer.length === 0) {
      return reject(`图片 ${displayName} 数据为空`)
    }

    if (img.buffer.length > UPLOAD_CONFIG.MAX_FILE_SIZE) {
      return reject(
        `图片 ${displayName} 超过大小限制 (${UPLOAD_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`
      )
    }

    // 只信任文件头：扩展名和 data URL 里声明的 MIME 都可以随便写
    if (!detectMimeTypeFromBuffer(img.buffer)) {
      return reject(`图片 ${displayName} 类型不支持或无法识别（仅支持 JPEG/PNG/GIF/WebP/BMP）`)
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
        // deleteUrl 仅供外部消费者读取，PicGo 的 GUI/剪贴板都不展示它
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
      // 图床级配置：当前无需用户填写，返回空数组即可（PicGo 会调用它渲染设置页）
      config: () => []
    })
  }

  // 插件级配置（存储于完整包名下）；本插件无额外配置。
  // 保留空实现是为了兼容会无条件调用 plugin.config() 的 PicGo 版本
  const config = () => []

  return {
    name: 'p-sda1-uploader',
    // 官方推荐：声明本插件提供的 uploader id，便于发现与设为当前图床
    uploader: 'p-sda1-uploader',
    register,
    config
  }
}
