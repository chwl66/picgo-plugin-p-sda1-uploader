// PicGo 插件：p-sda1-uploader

module.exports = (ctx) => {
  const register = () => {
    ctx.helper.uploader.register('p-sda1-uploader', {
      name: '流浪图床',
      handle: async function (ctx) {
        const imgList = ctx.output
        for (const img of imgList) {
          if (!img.buffer && img.base64Image) {
            img.buffer = Buffer.from(img.base64Image, 'base64')
          }
          const formData = {
            filename: img.fileName || 'picgo-upload.png'
          }
          try {
            const res = await ctx.request({
              method: 'POST',
              url: 'https://p.sda1.dev/api/v1/upload_external_noform',
              headers: {
                'Content-Type': 'application/octet-stream'
              },
              params: formData,
              body: img.buffer
            })
            ctx.log.info('p.sda1.dev 返回：' + JSON.stringify(res))
            // 兼容不同返回结构
            let url, deleteUrl
            let resObj = res
            if (typeof res === 'string') {
              try {
                resObj = JSON.parse(res)
              } catch (e) {
                ctx.log.error('返回内容不是合法JSON')
                throw new Error('返回内容不是合法JSON')
              }
            }
            if (resObj && resObj.data && resObj.data.url) {
              url = resObj.data.url
              deleteUrl = resObj.data.delete_url
            } else if (resObj && resObj.url) {
              url = resObj.url
              deleteUrl = resObj.delete_url
            }
            if (url) {
              img.imgUrl = url
              img.deleteUrl = deleteUrl
            } else {
              throw new Error('上传失败，未返回图片地址')
            }
          } catch (err) {
            ctx.log.error('上传到 p.sda1.dev 失败：' + err.message)
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