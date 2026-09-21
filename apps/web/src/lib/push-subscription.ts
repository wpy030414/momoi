// ============================================================
// Push Subscription Manager — 浏览器 Web Push 订阅生命周期
// ============================================================
// 仅在支持 Service Worker + PushManager 的环境下工作。
// 不支持时静默退出（无降级 —— 这是 Web Push 的硬性要求）。

/** 将 base64 字符串转为 Uint8Array（用于 applicationServerKey） */
function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const bytes = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    bytes[i] = rawData.charCodeAt(i)
  }
  return bytes
}

/** 检查浏览器是否支持 Web Push */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** 从服务端获取 VAPID 公钥 */
async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const resp = await fetch('/api/push-notification/vapid-public-key')
    const data = await resp.json()
    return data.publicKey || null
  } catch {
    return null
  }
}

/** 上报 subscription 到服务端 */
async function reportSubscription(deviceId: string, subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON()
  if (!json.keys?.p256dh || !json.keys?.auth) return

  await fetch('/api/push-notification/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    }),
  })
}

/** 主入口：在当前权限状态下订阅 Web Push（权限需已 granted，否则跳过） */
export async function subscribePush(userId: string): Promise<void> {
  // 1. 能力检测
  if (!isPushSupported()) {
    console.log('[push] Browser does not support Web Push')
    return
  }

  // 2. 权限必须已 granted（requestPermission 必须来自用户手势，由调用方提前处理）
  if (Notification.permission !== 'granted') {
    console.log('[push] Notification permission not granted')
    return
  }

  // 3. 获取 VAPID 公钥
  const vapidPublicKey = await fetchVapidPublicKey()
  if (!vapidPublicKey) {
    console.log('[push] Failed to fetch VAPID public key')
    return
  }

  // 4. 注册 Service Worker（幂等）
  let registration: ServiceWorkerRegistration
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    console.log('[push] Service Worker registered')
  } catch (err) {
    console.error('[push] Service Worker registration failed:', err)
    return
  }

  // 5. 等待 SW 就绪
  await navigator.serviceWorker.ready

  // 6. 订阅 Push
  const deviceId = getDeviceId()

  // 先检查是否已有订阅
  let subscription = await registration.pushManager.getSubscription()

  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // @ts-expect-error: node types conflict with DOM's BufferSource/Uint8Array
        applicationServerKey: urlB64ToUint8Array(vapidPublicKey),
      })
    } catch (err) {
      console.error('[push] PushManager.subscribe failed:', err)
      return
    }
  }

  // 7. 上报订阅到服务端
  await reportSubscription(deviceId, subscription)
  console.log('[push] Subscription reported to server')
}

/** 取消订阅 */
export async function unsubscribePush(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) return

  const subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    await subscription.unsubscribe()
  }

  await fetch('/api/push-notification/unsubscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: getDeviceId() }),
  })

  console.log('[push] Unsubscribed')
}

/** 获取 device_id（与 SSE 连接共用） */
function getDeviceId(): string {
  const key = 'momoi_device_id'
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
  }
  return id
}