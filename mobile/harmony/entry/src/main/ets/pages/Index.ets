import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { http } from '@kit.NetworkKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'CampusApp';
const PREF_NAME: string = 'campus-app';
const KEY_BASE: string = 'baseUrl';
const KEY_TOKEN: string = 'deviceToken';
const JSON_HEADER: string = '{"Content-Type":"application/json"}';

interface PairOk {
  ok?: boolean;
  token?: string;
}

interface PairErrDetail {
  code?: string;
  message?: string;
}

interface PairErr {
  ok?: boolean;
  error?: PairErrDetail;
}

interface PairRequest {
  code: string;
  deviceName: string;
  platform: string;
}

/**
 * 页面只有两种状态：没配对时显示配对表单，配对后用 ArkWeb 加载运行时的 WebUI。
 * 令牌只存 preferences（应用沙箱内），通过 URL 片段传给 Web 组件。
 */
@Entry
@Component
struct Index {
  @State paired: boolean = false;
  @State baseUrl: string = '';
  @State code: string = '';
  @State busy: boolean = false;
  @State errorText: string = '';
  @State pageUrl: string = 'about:blank';
  private controller: webview.WebviewController = new webview.WebviewController();

  prefOptions(): preferences.Options {
    const options: preferences.Options = { name: PREF_NAME };
    return options;
  }

  aboutToAppear(): void {
    const pendingUri: string = AppStorage.get<string>('campus.deeplink') ?? '';
    if (pendingUri.length > 0) {
      AppStorage.set<string>('campus.deeplink', '');
      this.applyDeeplink(pendingUri);
    }
    const context = getContext(this) as common.UIAbilityContext;
    const pref = preferences.getPreferencesSync(context, this.prefOptions());
    const base = pref.getSync(KEY_BASE, '') as string;
    const token = pref.getSync(KEY_TOKEN, '') as string;
    if (base.length > 0 && token.length > 0) {
      this.baseUrl = base;
      this.showWeb(base, token);
    }
  }

  /** 从 thucampus://pair?base=…&code=… 预填配对表单。 */
  applyDeeplink(uri: string): void {
    const baseMatch = /[?&]base=([^&]+)/.exec(uri);
    const codeMatch = /[?&]code=(\d{1,6})/.exec(uri);
    if (baseMatch !== null && baseMatch[1].length > 0) {
      this.baseUrl = decodeURIComponent(baseMatch[1]);
    }
    if (codeMatch !== null) {
      this.code = codeMatch[1];
    }
  }

  showWeb(base: string, token: string): void {
    this.pageUrl = base + '/#token=' + encodeURIComponent(token);
    this.paired = true;
  }

  savePair(base: string, token: string): void {
    const context = getContext(this) as common.UIAbilityContext;
    const pref = preferences.getPreferencesSync(context, this.prefOptions());
    pref.putSync(KEY_BASE, base);
    pref.putSync(KEY_TOKEN, token);
    pref.flush();
  }

  clearPair(): void {
    const context = getContext(this) as common.UIAbilityContext;
    const pref = preferences.getPreferencesSync(context, this.prefOptions());
    pref.deleteSync(KEY_BASE);
    pref.deleteSync(KEY_TOKEN);
    pref.flush();
    this.paired = false;
    this.pageUrl = 'about:blank';
    this.code = '';
  }

  startPair(): void {
    const base: string = this.baseUrl.trim().replace(/\/+$/, '');
    const codeOk: boolean = /^\d{6}$/.test(this.code);
    if ((!base.startsWith('http://') && !base.startsWith('https://')) || !codeOk) {
      this.errorText = '地址需以 http:// 开头，配对码为 6 位数字';
      return;
    }
    this.busy = true;
    this.errorText = '';
    const payload: PairRequest = {
      code: this.code,
      deviceName: 'HarmonyOS',
      platform: 'harmony'
    };
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.POST,
      header: JSON_HEADER,
      extraData: JSON.stringify(payload),
      connectTimeout: 15000,
      readTimeout: 20000,
      expectDataType: http.HttpDataType.STRING
    };
    const request = http.createHttp();
    request.request(base + '/api/pair/redeem', options)
      .then((response: http.HttpResponse) => {
        this.busy = false;
        const text: string = response.result as string;
        if (response.responseCode === 200) {
          const ok = JSON.parse(text) as PairOk;
          const token: string = ok.token ?? '';
          if (token.length === 0) {
            this.errorText = '配对失败：响应缺少令牌';
            return;
          }
          this.savePair(base, token);
          this.code = '';
          this.showWeb(base, token);
          return;
        }
        this.errorText = '配对失败：' + this.describeError(text, response.responseCode);
      })
      .catch((err: Error) => {
        this.busy = false;
        this.errorText = '配对失败：' + err.message;
        hilog.error(0x0000, TAG, 'pair failed %{public}s', err.message);
      })
      .finally(() => {
        request.destroy();
      });
  }

  describeError(text: string, status: number): string {
    try {
      const parsed = JSON.parse(text) as PairErr;
      const code: string = parsed.error?.code ?? '';
      if (code === 'PAIRING_EXPIRED') {
        return '配对码无效或已过期，请在电脑上重新生成';
      }
      if (code === 'PAIRING_LOCKED') {
        return '尝试过于频繁，请稍后再试';
      }
      if (code === 'PAIRING_INVALID') {
        return '配对码格式不对';
      }
      if (code === 'PAIRING_DISABLED') {
        return '这台电脑使用固定令牌，请改用带令牌的链接';
      }
      return parsed.error?.message ?? ('HTTP ' + status);
    } catch (e) {
      return 'HTTP ' + status;
    }
  }

  build() {
    Column() {
      if (this.paired) {
        Row() {
          Text('清华校园助手')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .layoutWeight(1)
          Button('解除配对')
            .fontSize(12)
            .height(32)
            .backgroundColor('#00000000')
            .fontColor('#B42318')
            .onClick(() => this.clearPair())
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 10, bottom: 10 })

        Web({ src: this.pageUrl, controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .width('100%')
          .layoutWeight(1)
      } else {
        Scroll() {
          Column() {
            Text('连接到你的电脑')
              .fontSize(22)
              .fontWeight(FontWeight.Bold)
              .width('100%')
            Text('在电脑上运行 node bin/thu-campus.mjs app serve，控制台会打印一次性 6 位配对码。配对后密码与验证码只在本机浏览器输入。')
              .fontSize(14)
              .fontColor('#5D6B7A')
              .margin({ top: 10, bottom: 20 })
              .width('100%')
            Text('服务器地址')
              .fontSize(13)
              .fontColor('#5D6B7A')
              .width('100%')
            TextInput({ placeholder: 'http://192.168.1.23:8971', text: this.baseUrl })
              .type(InputType.URL)
              .height(48)
              .margin({ top: 6, bottom: 14 })
              .onChange((value: string) => { this.baseUrl = value; })
            Text('配对码')
              .fontSize(13)
              .fontColor('#5D6B7A')
              .width('100%')
            TextInput({ placeholder: '000000', text: this.code })
              .type(InputType.Number)
              .maxLength(6)
              .height(48)
              .margin({ top: 6, bottom: 20 })
              .onChange((value: string) => { this.code = value; })
            Button(this.busy ? '正在配对…' : '配对并连接')
              .width('100%')
              .height(48)
              .enabled(!this.busy)
              .onClick(() => this.startPair())
            if (this.errorText.length > 0) {
              Text(this.errorText)
                .fontSize(13)
                .fontColor('#B42318')
                .margin({ top: 12 })
                .width('100%')
            }
          }
          .width('100%')
          .padding(24)
        }
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F7FA')
  }
}

