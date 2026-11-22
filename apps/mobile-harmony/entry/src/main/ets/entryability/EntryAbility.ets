import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const TAG: string = 'CampusApp';
const DEEPLINK_KEY: string = 'campus.deeplink';

/**
 * 瘦客户端入口：只负责加载 pages/Index，校园协议全部在电脑上的运行时里。
 * 深链 thucampus://pair?base=…&code=… 的参数通过 AppStorage 转给页面。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.captureDeeplink(want);
    hilog.info(0x0000, TAG, 'onCreate');
  }

  onNewIntent(want: Want): void {
    this.captureDeeplink(want);
  }

  captureDeeplink(want: Want): void {
    const uri: string = want.uri ?? '';
    if (uri.length > 0) {
      AppStorage.setOrCreate<string>(DEEPLINK_KEY, uri);
      hilog.info(0x0000, TAG, 'deeplink captured');
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0x0000, TAG, 'loadContent ok');
    });
  }

  onDestroy(): void {
    hilog.info(0x0000, TAG, 'onDestroy');
  }
}
