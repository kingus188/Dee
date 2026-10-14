export type WechatSettingsInput = { enabled: boolean; sendUrl: string; regenerate?: boolean };
export type WechatSettings = {
  enabled: boolean; sendUrl: string; webhookKey: string; sendToken: string; restartRequired: boolean;
};
