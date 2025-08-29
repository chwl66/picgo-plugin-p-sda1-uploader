// PicGo 插件：p-sda1-uploader
// 用于将图片上传到 p.sda1.dev 图床服务

module.exports = (ctx) => {
  const register = () => {
    ctx.helper.uploader.register('p-sda1-uploader', {
      name: '流浪图床',
      handle: async function (ctx) {
        const imgList = ctx.output
        
        // 处理每张图片
        for (const img of imgList) {
          // 如果只有base64数据，转换为buffer
          if (!img.buffer && img.base64Image) {
            img.buffer = Buffer.from(img.base64Image, 'base64')
          }
          
          // 验证图片数据是否存在
          if (!img.buffer) {
            ctx.log.error('缺少图片数据')
            throw new Error('缺少图片数据')
          }

          // 准备上传参数
          const formData = {
            filename: img.fileName || `picgo-upload-${Date.now()}.png`
          }
          
          try {
            // 发送上传请求到 p.sda1.dev API
            const res = await ctx.request({
              method: 'POST',
              url: 'https://p.sda1.dev/api/v1/upload_external_noform',
              headers: {
                'Content-Type': 'application/octet-stream'
              },
              params: formData,
              body: img.buffer,
              timeout: 30000 // 30秒超时
            })
            
            // 调试日志记录完整响应
            ctx.log.debug('p.sda1.dev 返回：' + JSON.stringify(res))
            
            let url, deleteUrl
            let resObj = res
            
            // 处理可能的字符串响应（需要JSON解析）
            if (typeof res === 'string') {
              try {
                resObj = JSON.parse(res)
              } catch (e) {
                ctx.log.error('返回内容不是合法JSON: ' + res.substring(0, 100))
                throw new Error('服务器返回格式错误')
              }
            }
            
            // 解析不同的响应格式
            if (resObj?.data?.url) {
              // 格式1: { data: { url: '', delete_url: '' } }
              url = resObj.data.url
              deleteUrl = resObj.data.delete_url
            } else if (resObj?.url) {
              // 格式2: { url: '', delete_url: '' }
              url = resObj.url
              deleteUrl = resObj.delete_url
            }
            
            // 检查是否成功获取到图片URL
            if (url) {
              img.imgUrl = url
              img.deleteUrl = deleteUrl
              ctx.log.info(`上传成功: ${url}`)
            } else {
              ctx.log.error('上传失败，未返回图片地址: ' + JSON.stringify(resObj))
              throw new Error('上传失败，服务器未返回有效地址')
            }
          } catch (err) {
            ctx.log.error('上传到 p.sda1.dev 失败: ' + err.message)
            throw err
          }
        }
        return ctx
      },
      config: []
    })
  }
  
  // 添加必需的 config 方法
  const config = ctx => {
    return []
  }

  // 返回修正后的插件结构
  return {
    name: 'p-sda1-uploader',
    register,
    config
  }
}