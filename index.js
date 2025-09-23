// PicGo 插件：p-sda1-uploader
// 用于将图片上传到 p.sda1.dev 图床服务

const UPLOAD_CONFIG = {
  API_URL: 'https://p.sda1.dev/api/v1/upload_external_noform',
  TIMEOUT: 30000,
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000
}

module.exports = (ctx) => {
  /**
   * 验证图片数据
   * @param {Object} img - 图片对象
   * @returns {boolean} 验证结果
   */
  const validateImage = (img) => {
    // 检查图片数据是否存在
    if (!img.buffer && !img.base64Image) {
      ctx.log.error(`图片 ${img.fileName || 'unknown'} 缺少数据`)
      return false
    }

    // 转换 base64 为 buffer
    if (!img.buffer && img.base64Image) {
      try {
        img.buffer = Buffer.from(img.base64Image, 'base64')
      } catch (error) {
        ctx.log.error(`图片 ${img.fileName || 'unknown'} base64 转换失败: ${error.message}`)
        return false
      }
    }

    // 检查文件大小
    if (img.buffer.length > UPLOAD_CONFIG.MAX_FILE_SIZE) {
      ctx.log.error(`图片 ${img.fileName || 'unknown'} 超过大小限制 (${UPLOAD_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`)
      return false
    }

    return true
  }

  /**
   * 解析服务器响应
   * @param {*} response - 服务器响应
   * @returns {Object} 解析后的结果
   */
  const parseResponse = (response) => {
    let resObj = response

    // 处理字符串响应
    if (typeof response === 'string') {
      try {
        resObj = JSON.parse(response)
      } catch (error) {
        throw new Error(`服务器返回格式错误: ${response.substring(0, 100)}`)
      }
    }

    // 解析不同的响应格式
    let url, deleteUrl
    if (resObj?.data?.url) {
      // 格式1: { data: { url: '', delete_url: '' } }
      url = resObj.data.url
      deleteUrl = resObj.data.delete_url
    } else if (resObj?.url) {
      // 格式2: { url: '', delete_url: '' }
      url = resObj.url
      deleteUrl = resObj.delete_url
    }

    if (!url) {
      throw new Error(`服务器未返回有效地址: ${JSON.stringify(resObj)}`)
    }

    return { url, deleteUrl }
  }

  /**
   * 延迟函数
   * @param {number} ms - 延迟毫秒数
   */
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * 上传单张图片（带重试机制）
   * @param {Object} img - 图片对象
   * @param {number} retryCount - 重试次数
   * @returns {Promise<Object>} 上传结果
   */
  const uploadSingleImage = async (img, retryCount = 0) => {
    const fileName = img.fileName || `picgo-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.png`
    
    try {
      const response = await ctx.request({
        method: 'POST',
        url: UPLOAD_CONFIG.API_URL,
        headers: {
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'PicGo-Plugin-p-sda1-uploader/1.0.0'
        },
        params: { filename: fileName },
        body: img.buffer,
        timeout: UPLOAD_CONFIG.TIMEOUT
      })

      ctx.log.debug(`p.sda1.dev 响应 (${fileName}): ${JSON.stringify(response)}`)

      const { url, deleteUrl } = parseResponse(response)
      
      return {
        success: true,
        url,
        deleteUrl,
        fileName
      }
    } catch (error) {
      const errorMsg = `上传失败 (${fileName}): ${error.message}`
      
      // 重试逻辑
      if (retryCount < UPLOAD_CONFIG.MAX_RETRIES) {
        ctx.log.warn(`${errorMsg}, 准备重试 (${retryCount + 1}/${UPLOAD_CONFIG.MAX_RETRIES})`)
        await delay(UPLOAD_CONFIG.RETRY_DELAY * (retryCount + 1))
        return uploadSingleImage(img, retryCount + 1)
      }
      
      ctx.log.error(`${errorMsg}, 已达到最大重试次数`)
      return {
        success: false,
        error: error.message,
        fileName
      }
    }
  }

  /**
   * 批量上传图片
   * @param {Array} imgList - 图片列表
   * @returns {Promise<Object>} 上传结果统计
   */
  const uploadImages = async (imgList) => {
    const results = {
      success: [],
      failed: [],
      total: imgList.length
    }

    // 并发上传所有图片
    const uploadPromises = imgList.map(async (img, index) => {
      try {
        // 验证图片
        if (!validateImage(img)) {
          results.failed.push({
            index,
            fileName: img.fileName || `image-${index}`,
            error: '图片验证失败'
          })
          return
        }

        // 上传图片
        const result = await uploadSingleImage(img)
        
        if (result.success) {
          img.imgUrl = result.url
          img.deleteUrl = result.deleteUrl
          results.success.push({
            index,
            fileName: result.fileName,
            url: result.url
          })
          ctx.log.info(`上传成功 (${index + 1}/${imgList.length}): ${result.url}`)
        } else {
          results.failed.push({
            index,
            fileName: result.fileName,
            error: result.error
          })
        }
      } catch (error) {
        results.failed.push({
          index,
          fileName: img.fileName || `image-${index}`,
          error: error.message
        })
        ctx.log.error(`处理图片失败 (${index + 1}/${imgList.length}): ${error.message}`)
      }
    })

    await Promise.all(uploadPromises)
    return results
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
          
          // 输出上传统计
          ctx.log.info(`上传完成: 成功 ${results.success.length}/${results.total}, 失败 ${results.failed.length}/${results.total}`)
          
          if (results.failed.length > 0) {
            ctx.log.warn('失败的图片:')
            results.failed.forEach(fail => {
              ctx.log.warn(`  - ${fail.fileName}: ${fail.error}`)
            })
          }

          // 如果全部失败，抛出错误
          if (results.success.length === 0) {
            throw new Error(`所有图片上传失败，请检查网络连接和服务状态`)
          }
          
        } catch (error) {
          ctx.log.error(`批量上传过程出错: ${error.message}`)
          throw error
        }

        return ctx
      },
      config: []
    })
  }
  
  const config = ctx => {
    return []
  }

  return {
    name: 'p-sda1-uploader',
    register,
    config
  }
}