'use strict'

// 上传主流程的集成测试：本地 mock 图床 + 模拟 PicGo 运行环境，零第三方依赖。
// 运行：npm test
//
// mock 的 ctx.request 复刻了 PicGo 核心（实测 2.0.3 / 3.0.2 一致）的错误约定：
// 非 2xx 抛出带 statusCode 的错误；超时/连接失败统一成 statusCode: 0 且不携带 error.code。
// 重试判定只能依赖这份约定，所以这些形状必须原样保留，不要"顺手整理"。

const http = require('http')
const plugin = require('../index.js')

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1)
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)])

const results = []
const check = (name, condition, detail) => {
  results.push({ name, pass: !!condition })
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
}

// PicGo 核心对非 2xx 的报错形状
const httpError = (status, body) => ({
  name: 'Error',
  message: `Request failed with status code ${status}`,
  statusCode: status,
  method: 'POST',
  url: 'https://p.sda1.dev/api/v1/upload_external_noform',
  response: { status, statusCode: status, data: body, headers: {} }
})

// PicGo 核心对"没拿到响应"（超时 / DNS / 连接失败）的报错形状：statusCode 为 0 且没有 code
const noResponseError = (message) => ({
  name: 'Error',
  message,
  statusCode: 0,
  method: 'POST',
  url: 'https://p.sda1.dev/api/v1/upload_external_noform',
  response: { status: 0, statusCode: 0, data: '', headers: {} }
})

const okUpload = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    code: 200,
    data: { url: 'https://p.sda1.dev/i/1.png', delete_url: 'https://p.sda1.dev/del/1' }
  }))
}

const queryOf = (url) => new URL(`http://mock${url}`).searchParams

// handle 只会以 throw 表达失败，测试里统一吞掉异常，由具体断言判断结果
const handle = async (uploader, ctx) => {
  try {
    await uploader.handle(ctx)
    return null
  } catch (error) {
    return error
  }
}

/**
 * 起一个本地 mock 图床，把插件发往 p.sda1.dev 的请求改写到这里。
 * @param {(req, res, state) => void} handler mock 行为
 * @param {(ctx, state) => Promise<void>} body 用例主体
 */
const withMockServer = async (handler, body) => {
  const state = { attempts: 0, requests: [], notifications: [], logs: [] }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      state.attempts += 1
      state.requests.push({
        url: req.url,
        method: req.method,
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent'],
        body: Buffer.concat(chunks)
      })
      handler(req, res, state)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const ctx = {
    output: [],
    log: {
      info: (msg) => state.logs.push({ level: 'info', msg }),
      warn: (msg) => state.logs.push({ level: 'warn', msg }),
      error: (msg) => state.logs.push({ level: 'error', msg }),
      debug: (msg) => state.logs.push({ level: 'debug', msg })
    },
    emit: (event, payload) => {
      if (event === 'notification') {
        state.notifications.push(payload)
      }
    },
    helper: {
      uploader: {
        register: (id, uploader) => {
          state.uploaderId = id
          state.uploader = uploader
        }
      }
    },
    request: (options) => new Promise((resolve, reject) => {
      const target = new URL(String(options.url).replace('https://p.sda1.dev', `http://127.0.0.1:${port}`))

      // 测试保护：改写后仍未落在回环地址上的请求一律就地失败，绝不外发
      if (target.hostname !== '127.0.0.1') {
        reject(noResponseError(`测试保护：请求未被重定向到本地 mock (${target.hostname})`))
        return
      }

      for (const [key, value] of Object.entries(options.params || {})) {
        target.searchParams.set(key, value)
      }

      const req = http.request(
        {
          method: options.method,
          hostname: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          headers: options.headers
        },
        (res) => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode >= 200 && res.statusCode < 300) {
              // PicGo 旧式请求选项下，响应体是字符串
              resolve(text)
            } else {
              reject(httpError(res.statusCode, text))
            }
          })
        }
      )

      req.setTimeout(options.timeout || 0, () => {
        req.destroy(new Error(`timeout of ${options.timeout}ms exceeded`))
      })

      req.on('error', (error) => {
        reject(/timeout of/.test(error.message)
          ? noResponseError(error.message)
          : noResponseError(`connect ${error.code || 'ECONNREFUSED'} 127.0.0.1:${port}`))
      })

      req.end(options.body)
    })
  }

  plugin(ctx).register()

  try {
    await body(ctx, state)
  } finally {
    server.close()
  }
}

const scenarios = [
  {
    name: '成功上传',
    handler: (req, res) => okUpload(res),
    images: () => [
      { fileName: 'a.png', buffer: PNG },
      { fileName: 'b.jpg', buffer: JPEG }
    ],
    assert: (ctx, state, thrown) => {
      check('两张图片都上传成功', ctx.output.length === 2 && thrown === null)
      check('注册了 uploader id', state.uploaderId === 'p-sda1-uploader')
      check('回写 imgUrl（PicGo 必填字段）', ctx.output[0].imgUrl === 'https://p.sda1.dev/i/1.png')
      check('回写 deleteUrl', ctx.output[0].deleteUrl === 'https://p.sda1.dev/del/1')
      check('上传成功后释放 buffer', ctx.output[0].buffer === undefined)

      const sent = state.requests[0]
      check('请求体按二进制原样发送', sent.body.equals(PNG) || sent.body.equals(JPEG))
      check('Content-Type 为 octet-stream', sent.contentType === 'application/octet-stream')
      check('User-Agent 带上插件版本',
        /^PicGo-Plugin-p-sda1-uploader\/\d+/.test(sent.userAgent), sent.userAgent)
      check('未发出 notification', state.notifications.length === 0)
    }
  },
  {
    name: '文件名净化',
    handler: (req, res) => okUpload(res),
    images: () => [{ fileName: '../../secret 照片#1.png', buffer: PNG }],
    assert: (ctx, state) => {
      const name = queryOf(state.requests[0].url).get('filename')
      check('路径穿越与非法字符被中和', name === 'secret_1.png', `filename=${name}`)
    }
  },
  {
    name: '类型伪装',
    handler: (req, res) => okUpload(res),
    images: () => [{ fileName: 'evil.png', buffer: Buffer.from('MZ this is not an image') }],
    assert: (ctx, state, thrown) => {
      check('伪装成图片的文件被拒绝并抛错', !!thrown && /所有图片上传失败/.test(thrown.message))
      check('校验失败不发出网络请求', state.attempts === 0, `attempts=${state.attempts}`)
      check('全失败时发出 notification', state.notifications.length === 1)
    }
  },
  {
    name: '体积超限',
    handler: (req, res) => okUpload(res),
    images: () => [{ fileName: 'big.png', buffer: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }],
    assert: (ctx, state, thrown) => {
      check('超过 5MB 被拒绝', !!thrown && /所有图片上传失败/.test(thrown.message))
      check('超限图片不发出网络请求', state.attempts === 0, `attempts=${state.attempts}`)
    }
  },
  {
    name: '部分失败',
    handler: (req, res) => okUpload(res),
    images: () => [
      { fileName: 'good.png', buffer: PNG },
      { fileName: 'bad.txt', buffer: Buffer.from('plain text') }
    ],
    assert: (ctx, state, thrown) => {
      check('部分失败不抛异常', thrown === null)
      check('失败项已从 ctx.output 移除',
        ctx.output.length === 1 && ctx.output[0].fileName === 'good.png')
      check('部分失败发出 notification',
        state.notifications.length === 1 && /部分/.test(state.notifications[0].title))
    }
  },
  {
    name: '返回地址白名单',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data: { url: 'https://evil.example.com/a.png' } }))
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    assert: (ctx, state, thrown) => {
      check('白名单外的返回地址被拒绝',
        !!thrown && /主机不在允许列表/.test(state.notifications[0].body))
      check('白名单错误不重试', state.attempts === 1, `attempts=${state.attempts}`)
    }
  },
  {
    name: '业务错误',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 400, message: 'file too large' }))
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    assert: (ctx, state, thrown) => {
      check('缺少 url 的业务响应被拒绝',
        !!thrown && /未返回有效地址/.test(state.notifications[0].body))
      check('业务错误不重试', state.attempts === 1, `attempts=${state.attempts}`)
    }
  },
  {
    name: 'HTTP 5xx 重试',
    handler: (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"code":500,"message":"boom"}')
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    attempts: 4,
    assert: (ctx, state) => {
      check('HTTP 5xx 重试（期望 4 次）', state.attempts === 4, `attempts=${state.attempts}`)
    }
  },
  {
    name: 'HTTP 429 重试',
    handler: (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
      res.end('{"code":429,"message":"rate limited"}')
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    attempts: 4,
    assert: (ctx, state) => {
      check('HTTP 429 重试（期望 4 次）', state.attempts === 4, `attempts=${state.attempts}`)
    }
  },
  {
    name: 'HTTP 404 不重试',
    handler: (req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"code":404}')
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    attempts: 1,
    assert: (ctx, state) => {
      check('HTTP 4xx（非 429）不重试', state.attempts === 1, `attempts=${state.attempts}`)
    }
  },
  {
    name: '超时全部失败重试',
    handler: (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }, 3000)
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    attempts: 4,
    timeout: 300,
    assert: (ctx, state) => {
      check('超时（statusCode: 0）重试（期望 4 次）', state.attempts === 4, `attempts=${state.attempts}`)
      check('响应丢失型失败提示核对重复文件',
        state.notifications.some(note => /重复文件/.test(note.title)),
        JSON.stringify(state.notifications.map(note => note.title)))
      check('重复风险提示排在失败通知之前',
        state.notifications[0]?.title === '流浪图床可能存在重复文件')
    }
  },
  {
    name: '超时后重试并成功',
    handler: (req, res, state) => {
      if (state.attempts === 1) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        }, 3000)
        return
      }
      okUpload(res)
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    attempts: 2,
    timeout: 300,
    assert: (ctx, state) => {
      check('超时后重试并最终成功', ctx.output[0]?.imgUrl === 'https://p.sda1.dev/i/1.png')
      check('超时恢复后只请求 2 次', state.attempts === 2, `attempts=${state.attempts}`)
      check('超时恢复后仍提示可能残留重复文件',
        state.logs.some(log => log.level === 'warn' && /重复文件/.test(log.msg)))
    }
  },
  {
    name: '建连失败后重试成功',
    handler: (req, res) => okUpload(res),
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    firstError: 'refused',
    assert: (ctx, state, thrown) => {
      check('连接被拒后重试成功',
        thrown === null && ctx.output[0]?.imgUrl === 'https://p.sda1.dev/i/1.png')
      // 建连阶段就失败，请求根本没送达，不存在落盘可能，不应打扰用户
      check('建连失败不标记重复风险',
        !state.logs.some(log => /重复文件/.test(log.msg)) && state.notifications.length === 0,
        JSON.stringify(state.notifications.map(note => note.title)))
    }
  },
  {
    name: 'DNS 失败后重试成功',
    handler: (req, res) => okUpload(res),
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    firstError: 'dns',
    assert: (ctx, state, thrown) => {
      check('getaddrinfo ENOTFOUND 会重试并最终成功',
        thrown === null && ctx.output[0]?.imgUrl === 'https://p.sda1.dev/i/1.png')
      check('DNS 失败不标记重复风险',
        !state.logs.some(log => /重复文件/.test(log.msg)) && state.notifications.length === 0)
    }
  },
  {
    name: 'HTTP 失败后重试成功',
    handler: (req, res, state) => {
      if (state.attempts === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"code":503}')
        return
      }
      okUpload(res)
    },
    images: () => [{ fileName: 'a.png', buffer: PNG }],
    assert: (ctx, state, thrown) => {
      check('5xx 后重试成功', thrown === null && ctx.output[0]?.imgUrl === 'https://p.sda1.dev/i/1.png')
      // 5xx 说明请求完整送达且服务端明确表态，不算"静默落盘"
      check('HTTP 错误不标记重复风险',
        !state.logs.some(log => /重复文件/.test(log.msg)) && state.notifications.length === 0)
    }
  }
]

const runScenario = async (scenario) => {
  await withMockServer(
    scenario.handler,
    async (ctx, state) => {
      if (scenario.timeout) {
        const inner = ctx.request
        ctx.request = (options) => inner(Object.assign({}, options, { timeout: scenario.timeout }))
      }
      if (scenario.firstError) {
        const injectedMessage = {
          timeout: 'timeout of 30000ms exceeded',
          refused: 'connect ECONNREFUSED 127.0.0.1:9',
          dns: 'getaddrinfo ENOTFOUND p.sda1.dev'
        }[scenario.firstError]
        const inner = ctx.request
        let injected = false
        ctx.request = (options) => {
          if (!injected) {
            injected = true
            return Promise.reject(noResponseError(injectedMessage))
          }
          return inner(options)
        }
      }
      ctx.output = scenario.images()
      const thrown = await handle(state.uploader, ctx)
      try {
        scenario.assert(ctx, state, thrown)
      } catch (error) {
        // 断言里访问到非预期结构时记为失败，而不是让整个套件中断
        check(`${scenario.name} 断言过程抛出异常`, false, error.message)
      }
    }
  )
}

const run = async () => {
  for (const scenario of scenarios) {
    await runScenario(scenario)
  }

  const failed = results.filter(item => !item.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

run().catch((error) => {
  console.error('测试框架自身出错:', error)
  process.exitCode = 1
})
