// Node ESM 解析钩子：给无扩展名的相对路径补 .ts（仅用于 Node 冒烟测试，Vite 构建不需要）
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidate = new URL(specifier + '.ts', pathToFileURL(parentPath));
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(specifier + '.ts', context);
    }
  }
  return nextResolve(specifier, context);
}
