import { isLocalDevice } from "@/local-harness/destination";
import { i18n } from "@/i18n";
import {
  buildDeviceListPresentation as buildDeviceListPresentationShared,
  toDeviceListItem as toDeviceListItemShared,
  toDeviceListItems as toDeviceListItemsShared,
  type DeviceListDeviceLike,
  type DeviceListVisibility,
} from '@cindy/maker-shared/device-list';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';

export * from '@cindy/maker-shared/device-list';

export function toDeviceListItems<TDevice extends DeviceListDeviceLike>(
  devices: readonly TDevice[],
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
) {
  return [
    ...devices.filter(d => isLocalDevice(d.deviceId)).map(d => toDeviceListItem(d, now, revokedDevices)),
    ...toDeviceListItemsShared(devices.filter(d => !isLocalDevice(d.deviceId)), now, revokedDevices, mobilePresentationLocalizer),
  ];
}

export function toDeviceListItem<TDevice extends DeviceListDeviceLike>(
  device: TDevice,
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
) {
  const item = toDeviceListItemShared(device, now, revokedDevices, mobilePresentationLocalizer);
  return isLocalDevice(device.deviceId) ? { ...item, canOpen: true, state: 'ready' as const, statusLabel: i18n.t('session.local.device'), statusDetail: i18n.t('session.local.runsHere') } : item;
}

export function buildDeviceListPresentation(
  visibility: Pick<DeviceListVisibility, 'availableCount' | 'hiddenUnavailableCount' | 'unavailableCount'>,
  showUnavailable: boolean,
) {
  return buildDeviceListPresentationShared(visibility, showUnavailable, mobilePresentationLocalizer);
}
