/**
 * The desktop secure value store for credentials.
 */
import { getDesktopBridge } from './bridge'

export async function setSecureValue(key: string, value: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.StoreSecureValue) {
    localStorage.setItem(key, value)
    return
  }
  await bridge.StoreSecureValue(key, value)
}

export async function getSecureValue(key: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.ReadSecureValue) {
    return localStorage.getItem(key) || ''
  }
  return bridge.ReadSecureValue(key)
}

export async function deleteSecureValue(key: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.DeleteSecureValue) {
    localStorage.removeItem(key)
    return
  }
  await bridge.DeleteSecureValue(key)
}
