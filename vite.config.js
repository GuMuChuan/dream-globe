import { defineConfig } from 'vite'

// 说明（中文注释仅存在于配置里，客户看到的源码是英文注释）：
// 这个项目要交付两种产物，两者的入口故意不同：
//   1) ES module —— 现代前端项目 import 用，入口 src/index.js，全部命名导出
//   2) IIFE 全局脚本 —— 客户明确要求「<script> 标签直接引入，不用打包工具」，
//      入口 src/global.js，把 DreamGlobe 类本身挂到 window，
//      这样客户写 new DreamGlobe(el) 就能用，不用写 DreamGlobe.DreamGlobe。
// Vite lib 模式一次只认一个入口，所以用 build 命令的 --mode 区分，
// 或者像这里：用环境变量 BUILD_TARGET 切换。npm run build 会跑两遍。
//
// 第三个目标 BUILD_TARGET=demo 走的是完全不同的路：普通「应用」模式，
// 以 index.html 为入口，把 three 和源码一起打进去，产出可直接托管的静态站
// （部署到 Cloudflare Pages 用）。它不能复用上面的 lib 模式——lib 模式没有
// HTML 入口，也不会处理 index.html 里的 <script type="module">。
const isGlobalBuild = process.env.BUILD_TARGET === 'global'
const isDemoBuild = process.env.BUILD_TARGET === 'demo'

// demo 站：应用模式。输出到 dist-demo/，避免和库产物 dist/ 混在一起
// （库产物是要发 npm 的，里面混进 index.html 和 three 的整包会很奇怪）。
const demoConfig = defineConfig({
  base: './',
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
  },
})

const libConfig = defineConfig({
  build: {
    // 第二次构建不要清空第一次的产物
    emptyOutDir: !isGlobalBuild,
    lib: {
      entry: isGlobalBuild ? 'src/global.js' : 'src/index.js',
      name: 'DreamGlobe',
      fileName: () => (isGlobalBuild ? 'dream-globe.iife.js' : 'dream-globe.es.js'),
      formats: isGlobalBuild ? ['iife'] : ['es'],
    },
    // 两种产物对 three 的处理刻意相反：
    //   ES 版：external。使用打包工具的项目几乎都已经装了 three，内联进去会
    //          让页面加载两份（600 kB+），而且两个 Three 实例的 instanceof
    //          互不相认，客户往场景里塞自己的 Mesh 时会出诡异的错。
    //   IIFE 版：内联。它存在的理由就是「一个 script 标签就能跑」，
    //          要求客户先自己引一份 three 就把这个理由取消了。
    rollupOptions: isGlobalBuild
      ? { output: { exports: 'default' } }
      : { external: ['three'] },
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
  },
})

export default isDemoBuild ? demoConfig : libConfig
