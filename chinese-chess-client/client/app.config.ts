import { ExpoConfig, ConfigContext } from 'expo/config';

const projectId = process.env.COZE_PROJECT_ID || process.env.EXPO_PUBLIC_COZE_PROJECT_ID;
const slugAppName = projectId ? `app${projectId}` : 'myapp';

export default ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
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
    "scheme": "myapp",
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
      "package": `com.anonymous.x${projectId || '0'}`
    },
    "web": {
      "bundler": "metro",
      "output": "single",
      "favicon": "./assets/images/app-icon.jpg"
    },
    "plugins": [
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
          "cameraPermission": `象棋人机对战App需要访问相机以拍摄照片和视频。`,
          "microphonePermission": `象棋人机对战App需要访问麦克风以录制视频声音。`,
          "recordAudioAndroid": true
        }
      ]
    ],
    "experiments": {
      "typedRoutes": true
    }
  }
}
