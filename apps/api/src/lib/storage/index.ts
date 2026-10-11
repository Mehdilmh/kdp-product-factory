import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { config } from '../../config';

export interface StorageAdapter {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/** Keys are generated server-side; this guard still rejects traversal or absolute paths. */
export function assertSafeKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes('..') || key.includes('//')) throw new Error(`Unsafe storage key: ${key}`);
}

export class LocalStorage implements StorageAdapter {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    assertSafeKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Storage path escapes root');
    return p;
  }
  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export class S3Storage implements StorageAdapter {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}
  async put(key: string, data: Uint8Array, contentType: string) {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    assertSafeKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return new Uint8Array(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let storage: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  if (storage) return storage;
  const c = config();
  if (c.STORAGE_DRIVER === 's3') {
    if (!c.S3_BUCKET) throw new Error('S3_BUCKET is required for STORAGE_DRIVER=s3');
    storage = new S3Storage(
      new S3Client({
        region: c.S3_REGION,
        endpoint: c.S3_ENDPOINT,
        forcePathStyle: c.S3_FORCE_PATH_STYLE === 'true',
        credentials: c.S3_ACCESS_KEY_ID ? { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
      }),
      c.S3_BUCKET,
    );
  } else storage = new LocalStorage(c.STORAGE_LOCAL_DIR);
  return storage;
}
export function setStorage(s: StorageAdapter) {
  storage = s;
}
