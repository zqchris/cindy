import { isLocalDevice } from '@/local-harness/destination';
import { useMemo, useRef } from "react";
import { useAuth } from "@/auth/AuthContext";
import { useDeviceLink } from "./DeviceLinkContext";
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { readRemoteTextFilePreview } from '@/session/remoteAbsFileFetch';
import type { MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import {
  createMobileMakerTransport,
  type MobileMakerTransport,
} from "./mobileMakerTransport";

export function useMobileMakerTransport(
  deviceId: string,
): MobileMakerTransport {
  const { invoke, openLink } = useDeviceLink();
  const { accountGeneration, apiFetch } = useAuth();
  const generation = useRef(accountGeneration);
  generation.current = accountGeneration;
  return useMemo(
    () => {
      const isCurrent = () => generation.current === accountGeneration;
      const assertCurrent = () => {
        if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
      };
      const maker = createMobileMakerTransport({
        deviceId,
        invoke,
        isCurrent,
      });
      if (isLocalDevice(deviceId)) {
        maker.fileBrowser.readBytes = async (workdir, relPath, signal) => {
          if (signal?.aborted) throw new Error('PREVIEW_CANCELLED');
          const result = await maker.fileBrowser.readFile(workdir, relPath);
          assertCurrent();
          if (!result.ok || signal?.aborted) throw new Error('FILE_READ_FAILED');
          const bytes = new TextEncoder().encode(result.data.content);
          let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
          const ext = relPath.split('.').pop()?.toLowerCase();
          return { ossKey: '', mimeType: ext === 'html' ? 'text/html' : ext === 'svg' ? 'image/svg+xml' : 'text/plain', size: bytes.length, inlineBase64: btoa(binary) };
        };
        return maker;
      }
      const readPreview = maker.fs.readTextFilePreview;
      maker.fs.readTextFilePreview = (path, options) => readRemoteTextFilePreview({
        maker, deviceId, openLink, isCurrent,
        readPreview: (path) => readPreview(path, { allowFileTransfer: true }),
        presignGet: (key) => apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', {
          baseUrl: DEVICE_LINK_API_BASE_URL, method: 'POST', body: { key }, assertCurrent,
        }),
        deleteOssObject: (key) => {
          if (isCurrent()) void apiFetch('/api/device-link/media', {
            baseUrl: DEVICE_LINK_API_BASE_URL, method: 'DELETE', body: { key }, assertCurrent,
          }).catch(() => undefined);
        },
      }, path, options?.signal);
      return maker;
    },
    [deviceId, invoke, openLink, accountGeneration, apiFetch],
  );
}
