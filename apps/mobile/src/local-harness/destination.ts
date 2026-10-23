/** An execution destination, never a device-link peer or a relay identity. */
export const LOCAL_DEVICE_ID = 'cindy:local';
export const isLocalDevice = (id?: string | null) => id === LOCAL_DEVICE_ID;
