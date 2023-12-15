import Taro from '@tarojs/api'

// export * from './ad'
// export * from './ai'
// export * from './alipay'
// export * from './base'
// export * from './canvas'
// export * from './cloud'
// export * from './data-analysis'
// export * from './device'
// export * from './ext'
// export * from './files'
// export * from './framework'
// export * from './location'
export * from './media'
// export * from './navigate'
// export * from './network'
// export * from './open-api'
// export * from './payment'
// export * from './qq'
// export * from './route'
// export * from './share'
// export * from './storage'
// export * from './swan'
// export * from './ui'

// export * from './worker'
// export * from './wxml'

export {   chooseMessageFile,createLivePusherContext,createMediaAudioPlayer,createMediaContainer,createMediaRecorder,createVideoContext,createVideoDecoder,createWebAudioContext,cropImage,editImage,getApp,
  getAvailableAudioSources,getBackgroundAudioManager,getBackgroundAudioPlayerState,  getCurrentInstance,
  getCurrentPages,
  navigateBack,
  navigateTo,
  nextTick,
  onBackgroundAudioPause,onBackgroundAudioPlay,onBackgroundAudioStop,pauseBackgroundAudio,pauseVoice,playBackgroundAudio,playVoice,  redirectTo,
  reLaunch,
  seekBackgroundAudio,setInnerAudioOption,startRecord,stopBackgroundAudio,stopRecord,  switchTab } from '@tarojs/taro-h5'

Taro.eventCenter.on('__taroSetNavigationStyle', (style, textStyle, backgroundColor) => {
  if (typeof window !== 'undefined') {
    // @ts-ignore
    window.native?.setNavigationStyle?.(style, textStyle, backgroundColor)
    // @ts-ignore
    window.currentNavigationStyle = style
  }
})
