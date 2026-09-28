import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";

/* ------------------------------------------------------------------ */
/*  本周签到结果累计（周一发周报时使用）                                */
/* ------------------------------------------------------------------ */

// 读取已累计的签到记录；任何异常都退化为空数组，绝不影响主流程
function readWeeklyLog() {
  const raw = process.env.WEEKLY_SUMMARY
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.days) ? parsed.days : []
  } catch (e) {
    printYellow("历史签到记录解析失败，本次从空开始累计")
    return []
  }
}

// 写回累计记录；失败只告警，绝不抛错 —— PAT 过期等情况不该再把整次运行判成失败
function writeWeeklyLog(days) {
  if (!hasSecretWriteToken()) {
    printYellow("未配置 PAT，本周累计记录无法保存（不影响签到）")
    return false
  }
  try {
    setRepoSecret("WEEKLY_SUMMARY", JSON.stringify({ days: days.slice(-7) }))
    printGreen(`已累计本周签到记录 ${Math.min(days.length, 7)} 天`)
    return true
  } catch (e) {
    printYellow(`本周累计记录写入失败（不影响签到）: ${e?.message || e}`)
    return false
  }
}

// 只有这两类算真异常；「今日已领」（当天额度已用完）属于正常，不计入失败
function isBadStatus(status) {
  return status === '失败' || status === '部分失败'
}

// 取某条记录的星期；字段缺失或越界时由日期反推，避免出现「周undefined」
function dowOf(day) {
  if (Number.isInteger(day?.dow) && day.dow >= 0 && day.dow <= 6) return day.dow
  const t = new Date(`${String(day?.date || '').slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(t.getTime()) ? 0 : t.getUTCDay()
}

// 把一周记录 + 今天的结果渲染成周报正文
function buildWeeklyContent(history, todayRecord, isTest) {
  const DOW = ['日', '一', '二', '三', '四', '五', '六']
  let out = ''
  if (history.length) {
    out += `📅 周期: ${history[0].date} ~ ${history[history.length - 1].date}\n`
    out += `📊 记录天数: ${history.length} 天\n\n`

    // 按账号分组汇总
    const byName = {}
    for (const d of history) {
      for (const a of (d.accounts || [])) {
        const key = a.n || '未知'
        const b = (byName[key] = byName[key] || { ok: 0, fail: 0, claim: 0, expiry: '未知' })
        if (isBadStatus(a.s)) b.fail++; else b.ok++
        const got = Number(String(a.c || '0').split('/')[0])
        if (Number.isFinite(got)) b.claim += got
        if (a.v && a.v !== '未知') b.expiry = a.v
      }
    }
    for (const n of Object.keys(byName)) {
      const b = byName[n]
      out += `【${n}】\n`
      out += `  ✅ 成功 ${b.ok} 天   ❌ 失败 ${b.fail} 天\n`
      out += `  🎁 累计领取 ${b.claim} 次\n`
      out += `  ⏰ VIP到期 ${b.expiry}\n\n`
    }
    out += `─── 每日明细 ───\n`
    for (const d of history) {
      const ok = (d.accounts || []).every(a => !isBadStatus(a.s))
      const parts = (d.accounts || []).map(a => `${a.n} ${a.s} 🎵${a.l} 🎁${a.c}`).join(' | ')
      out += `${ok ? '✅' : '⚠️'} ${d.date} 周${DOW[dowOf(d)]}  ${parts}\n`
    }
  } else {
    out += `📅 周期: ${todayRecord.date}\n`
    out += `⚠️ 暂无历史累计记录（首次启用周报，或 PAT 未配置导致无法保存），以下仅含当天\n\n`
  }

  out += `\n─── 今日 ${todayRecord.date} 周${DOW[todayRecord.dow]} ───\n`
  for (const a of todayRecord.accounts) {
    const mark = a.s === '失败' ? '❌' : (isBadStatus(a.s) ? '⚠️' : '✅')
    out += `${mark} ${a.n} ${a.s}  🎵${a.l}  🎁${a.c}  ⏰${a.v}\n`
  }
  if (isTest) {
    out += `\n（这是手动触发的测试邮件，不会改动周期统计，也不影响每日签到）\n`
  }
  return out
}

async function main() {

  const USERINFO = process.env.USERINFO
  // 刷新token
  let needRefresh = false
  if (!USERINFO) {
    throw new Error("未配置")
  }
  const userinfo = JSON.parse(USERINFO)

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  const today = new Date();
  // 服务器时间比国内慢8小时
  today.setTime(today.getTime() + 8 * 60 * 60 * 1000)
  //日期
  const DD = String(today.getDate()).padStart(2, '0'); // 获取日
  const MM = String(today.getMonth() + 1).padStart(2, '0'); //获取月份，1 月为 0
  const yyyy = today.getFullYear(); // 获取年份
  const date = yyyy + '-' + MM + '-' + DD

  const errorMsg = {}
  // 通知结果收集
  const notifyResults = []
  let hasError = false

  try {
    // 开始签到
    for (const user of userinfo) {
      // 单账号异常隔离：任何一个账号的请求/解析出错，只记录该账号失败，
      // 不影响其余账号继续执行，也保证后续通知与 secret 刷新一定能触发。
      try {
        let headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers)
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid)
          printRed(`token过期或账号不存在, userid: ${safeUserId}`)
          errorMsg[safeUserId] = {
            msg: `token过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail)
          }
          notifyResults.push({
            nickname: safeUserId,
            status: '失败',
            listen: '账号不存在',
            vipClaim: '0/8',
            vipExpiry: '未知',
            error: 'token过期或账号不存在'
          })
          hasError = true
          continue
        }
        const safeNickname = maskDisplayName(userDetail.data.nickname)
        printMagenta(`账号 ${safeNickname} 开始领取VIP...`)

        // 周日刷新token
        if (today.getDay() === 0) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers)
          if (refreshToken?.status == 1) {
            if (refreshToken?.data?.token !== user.token) {
              needRefresh = true
              printYellow(`账号 ${safeNickname} 需要刷新token`)
              user.token = refreshToken.data.token
              // 用新 token 重建本次请求的 headers，使后续听歌/VIP 领取使用刷新后的凭证
              headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
            }
          }
        }

        // 开始听歌
        printYellow(`开始听歌领取VIP...`)
        // 听歌获取vip
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers)

        let listenStatus = '未知'
        if (listen.status === 1) {
          printGreen("听歌领取成功")
          listenStatus = '成功'
        } else if (listen.error_code === 130012) {
          printGreen("今日已领取")
          listenStatus = '今日已领取'
        } else {
          errorMsg[`${safeNickname} listen`] = summarizeResponse(listen)
          printRed("听歌领取失败")
          listenStatus = '失败'
          hasError = true
        }

        printYellow("开始领取VIP...")
        let claimCount = 0
        let claimTotal = 0
        let usedUp = false // 今天额度已用完（已领过），区别于真正的领取失败
        for (let i = 1; i <= 8; i++) {
          // ad获取vip
          const ad = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers)
          claimTotal = i
          if (ad.status === 1) {
            printGreen(`第${i}次领取成功`)
            claimCount++
            if (i != 8) {
              await delay(30 * 1000)
            }
          } else if (ad.error_code === 30002) {
            printGreen("今天次数已用光")
            usedUp = true
            break
          } else {
            printRed(`第${i}次领取失败`)
            errorMsg[`${safeNickname} ad`] = summarizeResponse(ad)
            hasError = true
            break
          }
        }

        let vipExpiry = '未知'
        const vip_details = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
        if (vip_details.status === 1 && Array.isArray(vip_details.data?.busi_vip) && vip_details.data.busi_vip.length > 0) {
          vipExpiry = vip_details.data.busi_vip[0].vip_end_time
          printBlue(`今天是：${date}`)
          printBlue(`VIP到期时间：${vipExpiry}\n`)
        } else {
          printRed("获取失败\n")
          errorMsg[`${safeNickname} vip_details`] = summarizeResponse(vip_details)
          hasError = true
        }

        // 「今日已领」= 当天额度本就用完了（比如已手动领过），不是失败，不该在周报里显示成异常
        let finalStatus
        if (listenStatus === '失败') finalStatus = '失败'
        else if (claimCount === 0) finalStatus = usedUp ? '今日已领' : '部分失败'
        else finalStatus = '成功'

        notifyResults.push({
          nickname: safeNickname,
          status: finalStatus,
          listen: listenStatus,
          vipClaim: `${claimCount}/${claimTotal}`,
          vipExpiry,
          error: ''
        })
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || '未知')
        printRed(`账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`)
        errorMsg[safeUserId] = { msg: '处理异常', error: err && err.message ? err.message : String(err) }
        notifyResults.push({
          nickname: safeUserId,
          status: '失败',
          listen: '异常',
          vipClaim: '0/8',
          vipExpiry: '未知',
          error: err && err.message ? err.message : String(err)
        })
        hasError = true
        continue
      }
    }

  } finally {
    close_api(api)
  }

  // 更新secret <USERINFO>（使用完整 userinfo 数组，保留所有用户包括过期账号）
  let secretError = null
  if (needRefresh) {
    if (hasSecretWriteToken()) {
      const userinfoJSON = JSON.stringify(userinfo)
      try {
        setRepoSecret("USERINFO", userinfoJSON)
        printGreen("secret <USERINFO> token刷新成功")
      } catch (error) {
        printRed("token刷新失败")
        console.dir(sanitizeForLog({ message: error.message }), { depth: null })
        secretError = new Error("secret <USERINFO> token刷新失败")
      }
    } else {
      printYellow("存在账号需要刷新token，但是未配置PAT，未刷新token最多两个月后过期")
    }
  }

  // 构建通知内容（放在 secret 更新之后、错误抛出之前，确保始终执行）
  let title = `酷狗签到${hasError ? '异常' : '成功'} ${date}`
  let content = `📅 日期: ${date}\n`
  content += `📊 账号数: ${notifyResults.length}\n`
  const successCount = notifyResults.filter(r => r.status === '成功').length
  const failCount = notifyResults.length - successCount
  content += `✅ 成功: ${successCount}  ❌ 失败: ${failCount}\n`

  for (const r of notifyResults) {
    content += `\n【${r.nickname}】\n`
    content += `  🎵 听歌领取: ${r.listen}\n`
    content += `  🎁 VIP领取: ${r.vipClaim} 次\n`
    content += `  ⏰ VIP到期: ${r.vipExpiry}\n`
    if (r.error) {
      content += `  ⚠️ 错误: ${r.error}\n`
    }
  }

  // ── 本周签到结果累计 ──
  // 每天把当次结果存进仓库 Secret <WEEKLY_SUMMARY>，周一发周报时汇总成整周明细。
  // 读/写失败只告警，绝不让整次运行失败（PAT 过期曾把整次 run 误判成失败，别重蹈覆辙）。
  const storedDays = readWeeklyLog()
  const history = storedDays.filter(d => d && d.date && d.date !== date).slice(-7)
  const todayRecord = {
    date,
    dow: today.getDay(),
    accounts: notifyResults.map(r => ({
      n: r.nickname, s: r.status, l: r.listen, c: r.vipClaim, v: r.vipExpiry,
    })),
  }

  // 手动触发时的测试开关：强制发一封周报邮件，且不改动周期统计
  const isTest = process.env.NOTIFY_TEST === 'true'

  // 邮箱通知频率控制：默认只在每周一（北京时间）发送邮件，其余日期跳过，避免每天收信。
  // 仅影响「邮箱」渠道，其它渠道（Server酱 / PushPlus / 企业微信等）仍按原频率每天发送。
  // 当天出现硬性异常（token 失效、领取失败、脚本报错）时不受限制，仍然立即发送，
  // 避免问题被压到下一周才发现；「今日已领取 / 次数已用光」这类正常情况不算异常，不会发信。
  // 如需改到别的星期：仓库 Settings → Secrets and variables → Variables 新增
  // NOTIFY_MAIL_DOW（0=周日、1=周一 …… 6=周六），无需改代码。
  const notifyMailDowRaw = process.env.NOTIFY_MAIL_DOW
  const notifyMailDowParsed = (notifyMailDowRaw === undefined || notifyMailDowRaw === '') ? NaN : Number(notifyMailDowRaw)
  const WEEKLY_MAIL_DOW = (Number.isInteger(notifyMailDowParsed) && notifyMailDowParsed >= 0 && notifyMailDowParsed <= 6) ? notifyMailDowParsed : 1
  const isMailNotifyDay = today.getDay() === WEEKLY_MAIL_DOW
  const hasAbnormal = hasError || notifyResults.some(r => r.status === '失败')
  const sendMail = isMailNotifyDay || hasAbnormal || isTest
  if (!sendMail) {
    delete process.env.MAIL_HOST
    delete process.env.MAIL_USER
    delete process.env.MAIL_PASS
    delete process.env.MAIL_TO
    printYellow(`今天不是每周邮件通知日（每周${'日一二三四五六'[WEEKLY_MAIL_DOW]}），已跳过邮件通知`)
  }

  // 周一（或手动测试）时改用周报格式：整周汇总 + 今天的即时结果
  if (isMailNotifyDay || isTest) {
    const range = history.length ? `${history[0].date} ~ ${history[history.length - 1].date}` : date
    title = `酷狗签到周报 ${range}${isTest ? '（测试）' : ''}`
    content = buildWeeklyContent(history, todayRecord, isTest)
  }

  // 发送通知（确保即使 secret 更新失败也能发出）
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  // 周期统计回写：周一发完周报后以今天为新起点重新累计；其余日期追加当天结果。
  // 手动测试不改动任何统计，避免干扰真实数据。
  if (!isTest) {
    writeWeeklyLog(isMailNotifyDay ? [todayRecord] : history.concat([todayRecord]).slice(-7))
  }

  if (Object.keys(errorMsg).length > 0) {
    printRed("异常信息如下:")
    console.dir(sanitizeForLog(errorMsg), { depth: null })
    throw new Error("领取异常")
  }

  if (secretError) {
    throw secretError
  }

}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
