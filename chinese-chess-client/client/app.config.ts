import { ExpoConfig, ConfigContext } from 'expo/config';

const projectId = process.env.COZE_PROJECT_ID || process.env.EXPO_PUBLIC_COZE_PROJECT_ID;
const slugAppName = projectId ? `app${projectId}` : 'ChineseChess';

// EAS 项目 ID（eas init 生成）
const EAS_PROJECT_ID = 'b6d34efc-7878-4a23-850d-d1cecb5aad6d';

export default ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    "owner": "tto_cn",
    "name": "中国象棋",
    "slug": slugAppName,
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/images/app-icon.jpg",
    "splash": {
      "image": "./assets/images/app-icon.jpg",
      "resizeMode": "cover",
      "backgroundColor": "#0e2b22"
    },
    "scheme": "ChineseChess",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "ios": {
      "supportsTablet": true
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/app-icon.jpg",
        "backgroundColor": "#0e2b22"
      },
      "package": "com.tto_cn.chinesechess"
    },
    "web": {
      "bundler": "metro",
      "output": "single",
      "favicon": "./assets/images/app-icon.jpg"
    },
    "plugins": [
      "expo-font",
      "expo-web-browser",

      // ⬇️ 新增：expo-build-properties（开启混淆 + 资源压缩，减小 APK 体积）
      //
      // ⚠️【2026-10-24 实机闪退修复】release 混淆从未在真机验证过（10-17/18 的真机复验
      //    全部走 development build + Metro，见 CLIENT-PIKAFISH-OFFLINE.md），首次带
      //    ProGuard 的 release 包出现「进入在线对局房间即闪退」。lanBattle 是全应用唯一
      //    在挂载首帧建立原生 WebSocket（okhttp3）的页面（大厅仅 fetch、PVE 无 WS），
      //    与崩溃时机吻合；而 RN 默认 proguard 规则对 okhttp 只有 -dontwarn、没有 keep。
      //    因此这里追加保守 keep：okhttp/okio（WS 通道）与 expo 模块反射注册面。
      //    enableShrinkResources 同步关闭：res/raw 下的引擎 wasm/nnue/html 与 RN 静态
      //    资源靠运行时 getIdentifier 动态查找，resource shrinker 存在误删风险，
      //    体积收益（几百 KB）不值得赌。minify 保留（崩溃面对 keep 规则兜住后收益仍在）。
      [
        "expo-build-properties",
        {
          "android": {
            "enableProguardInReleaseBuilds": true,
            "enableShrinkResources": false,
            "useLegacyPackaging": false,
            "extraProguardRules": [
              // —— 在线对局 WebSocket（lanBattle 首帧建连）——
              "-keep class okhttp3.** { *; }",
              "-keep interface okhttp3.** { *; }",
              "-keep class okio.** { *; }",
              "-dontwarn okhttp3.**",
              "-dontwarn okio.**",
              // —— RN WebSocket 模块与桥接面（反射/DoNotStrip 之外的兜底）——
              "-keep class com.facebook.react.modules.websocket.** { *; }",
              // —— expo 模块（Kotlin 反射注册，keeps 规则之外的显式兜底）——
              "-keep class expo.modules.** { *; }",
              "-keep class com.reactnativecommunity.webview.** { *; }"
            ].join("\n")
          }
        }
      ],

      // ⬇️ 本地引擎（皮卡鱼 / 揭棋）离线资源解析所依赖的原生模块。
      //    它是 expo 的**传递依赖**，pnpm 严格布局下不会被提升到 client/node_modules，
      //    必须显式声明为直接依赖 + 在此登记，原生模块才会随 prebuild 进 dex。
      //    缺了它，原生端只能拿到 Android「裸资源名」，WebView 无法导航 ——
      //    表现为两个引擎永远停在「启动中」，且**不报任何错**。
      "expo-asset",

      process.env.EXPO_PUBLIC_BACKEND_BASE_URL ? [
        "expo-router",
        {
          "origin": process.env.EXPO_PUBLIC_BACKEND_BASE_URL
        }
      ] : 'expo-router',

      // 启动画面通过上方 splash 字段配置（原生闪屏展示应用图标），
      // 不额外配置 expo-splash-screen 插件做 JS 自定义控制；
      // Android 12+ 系统级图标闪屏由系统控制。

      // 相册/相机选图：**显式关闭录音权限**。
      // ⚠️ 2026-10-17 真机取证：音效无声与音频路由被切到通信路由有关，
      //    而 RECORD_AUDIO 会让系统把本应用归类为「通话类」应用，
      //    音频策略上更容易走 earpiece / INCALL_MUSIC，媒体扬声器不出声。
      // ⚠️ 必须写成显式的 `false`：expo-image-picker 的插件是
      //    `if (microphonePermission !== false) { +RECORD_AUDIO }`
      //    （withImagePicker.js:34-35）——**省略该 key 会让它取默认值并加上权限**，
      //    这正是本次改动前 APK 里 RECORD_AUDIO 的真实来源（不是 expo-camera）。
      [
        "expo-image-picker",
        {
          "photosPermission": `允许象棋人机对战App访问您的相册，以便您上传或保存图片。`,
          "cameraPermission": `允许象棋人机对战App使用您的相机，以便您直接拍摄照片上传。`,
          "microphonePermission": false
        }
      ],
      [
        "expo-location",
        {
          "locationWhenInUsePermission": `象棋人机对战App需要访问您的位置以提供周边服务及导航功能。`
        }
      ],
      [
        "expo-camera",
        {
          "cameraPermission": `允许象棋人机对战App使用相机以拍摄照片和视频。`,
          // 同样必须显式 false：省略时插件会填入默认麦克风用途说明。
          "microphonePermission": false,
          // ⚠️ 必须保持 false：expo-camera 插件是
          //    `recordAudioAndroid && 'android.permission.RECORD_AUDIO'`
          //    （withCamera.js:18），只有显式 false 才不会申请录音。
          //    录音会让系统把本应用归为「通话类」，音频路由被切到
          //    earpiece / INCALL_MUSIC —— 2026-10-17 真机取证中音效无声的方向。
          //    本工程没有任何 CameraView / launchCamera 调用，录音纯属多余。
          "recordAudioAndroid": false
        }
      ]
    ],
    "experiments": {
      "typedRoutes": true
    },
    "extra": {
      ...(config.extra ?? {}),
      eas: {
        projectId: EAS_PROJECT_ID
      }
    }
  }
}
