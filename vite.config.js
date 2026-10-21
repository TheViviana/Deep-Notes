import {defineConfig} from 'vite';

// base 用相对路径，构建产物可以直接部署在任意子路径。
// worker.format 用 'es'：pdf.worker 以内联模块方式启动（src/neural/pdfParse.js 的 ?worker&inline），
// file:// 打包环境也能起真 worker，不再退回主线程假 worker。
export default defineConfig({
  base: './',
  worker: {format: 'es'},
});
