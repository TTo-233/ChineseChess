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
      [
        "expo-build-properties",
        {
          "android": {
            "enableProguardInReleaseBuilds": true,
            "enableShrinkResources": true,
            "useLegacyPackaging": false
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
      [
        "expo-image-picker",
        {
          "photosPermission": `允许象棋人机对战App访问您的相册，以便您上传或保存图片。`,
          "cameraPermission": `允许象棋人机对战App使用您的相机，以便您直接拍摄照片上传。`,
          "microphonePermission": `允许象棋人机对战App访问您的麦克风，以便您拍摄带有声音的视频。`
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
          "microphonePermission": `允许象棋人机对战App访问您的麦克风，以便您拍摄带有声音的视频。`,
          "recordAudioAndroid": true
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
