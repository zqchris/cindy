import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
export function localScope() {
  const owner = getMobileAuthOwner();
  if (owner.switching) throw new Error('ACCOUNT_REQUIRED');
  return {
    key: `cindy.mobile-harness.${bytesToHex(sha256(utf8ToBytes(owner.accountKey || 'device-local-v1')))}`,
    assert() { if (!isMobileAuthOwnerCurrent(owner)) throw new Error('ACCOUNT_CHANGED'); },
  };
}
