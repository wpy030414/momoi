declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }

  export interface VapidKeys {
    publicKey: string
    privateKey: string
  }

  export function generateVAPIDKeys(): VapidKeys

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>
}