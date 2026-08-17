import { join } from 'node:path';

const REQUIRED_DEPENDENCIES = [
  'getDataRoot', 'ensureDirectory', 'readStoredJson', 'atomicWriteJson',
  'withStoreLock', 'throwIfAborted', 'safeId', 'readBook',
];

// StoreContext 是领域存储模块访问底层能力的唯一入口。它只保存函数引用，
// resolvePath/ensureDataRoot 每次都读取当前根目录，避免 setDataRoot 后子模块
// 继续使用创建时缓存的旧路径。
export function createStoreContext(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new TypeError('STORE_CONTEXT_INVALID');
  }
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[name] !== 'function') {
      throw new TypeError(`STORE_CONTEXT_${name.toUpperCase()}_REQUIRED`);
    }
  }
  return Object.freeze({
    getDataRoot: dependencies.getDataRoot,
    resolvePath: (...parts) => join(dependencies.getDataRoot(), ...parts),
    ensureDataRoot: () => dependencies.ensureDirectory(dependencies.getDataRoot()),
    ensureDirectory: dependencies.ensureDirectory,
    readStoredJson: dependencies.readStoredJson,
    atomicWriteJson: dependencies.atomicWriteJson,
    withStoreLock: dependencies.withStoreLock,
    throwIfAborted: dependencies.throwIfAborted,
    safeId: dependencies.safeId,
    readBook: dependencies.readBook,
  });
}
