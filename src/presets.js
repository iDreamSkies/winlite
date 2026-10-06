// Описания твиков реестра (id совпадают со списком в бэкенде) и быстрые пресеты.
(function () {
  window.TWEAK_GROUPS = {
    ads: { t: 'Реклама', icon: 'megaphone' },
    tel: { t: 'Трекеры и слежка', icon: 'eye-off' },
  };

  // r: safe | caution — насколько заметно меняется поведение системы
  window.TWEAKS = {
    ads_id:       { g: 'ads', r: 'safe', t: 'Рекламный идентификатор', d: 'Windows выдаёт каждому пользователю уникальный ID, по которому приложения показывают персонализированную рекламу.', off: 'Реклама в приложениях станет менее «точной». Работе системы не мешает.' },
    ads_start:    { g: 'ads', r: 'safe', t: 'Предложения и реклама в меню «Пуск»', d: 'Убирает рекомендованные приложения и «советы» в меню «Пуск».', off: 'Ярлыки ваших программ остаются, пропадают только рекомендации Microsoft.' },
    ads_settings: { g: 'ads', r: 'safe', t: 'Реклама в приложении «Параметры»', d: 'Предложения и советы внутри Параметров (про OneDrive, Edge, аккаунт Microsoft).', off: 'Из Параметров пропадут баннеры с предложениями.' },
    ads_lock:     { g: 'ads', r: 'safe', t: 'Реклама на экране блокировки', d: 'Факты, советы и рекламные подсказки поверх картинки экрана блокировки.', off: 'Картинка остаётся, пропадают подписи и советы.' },
    ads_apps:     { g: 'ads', r: 'safe', t: 'Автоустановка рекламных приложений', d: 'Windows сама ставит спонсорские приложения (игры, соцсети и т. п.) при обновлениях и для новых пользователей.', off: 'Уже установленные приложения не удаляются, новые не появятся.' },
    ads_explorer: { g: 'ads', r: 'safe', t: 'Реклама в проводнике', d: 'Баннеры про OneDrive и другие сервисы Microsoft в окне проводника.', off: 'Баннеры в проводнике исчезнут.' },
    ads_setup:    { g: 'ads', r: 'safe', t: 'Напоминания «Завершите настройку устройства»', d: 'Полноэкранные предложения после обновлений: подключить телефон, включить Edge, войти в аккаунт.', off: 'Полноэкранные предложения перестанут появляться.' },

    tel_core:     { g: 'tel', r: 'safe', t: 'Отправка диагностических данных', d: 'Ограничивает телеметрию до минимума, разрешённого вашей редакцией Windows, и отключает запросы отзывов.', off: 'В редакции Pro минимальный уровень всё равно отправляет базовые данные, это ограничение самой Windows. Работе системы не мешает.' },
    tel_tailored: { g: 'tel', r: 'safe', t: 'Персонализация по данным диагностики', d: 'Microsoft использует данные диагностики, чтобы подбирать вам советы, рекомендации и рекламу.', off: 'Советы станут общими, а не подобранными под вас.' },
    tel_errors:   { g: 'tel', r: 'safe', t: 'Отчёты об ошибках', d: 'После сбоя программы Windows собирает и отправляет отчёт в Microsoft.', off: 'Windows перестанет предлагать отправить отчёт после сбоя.' },
    tel_appcompat:{ g: 'tel', r: 'safe', t: 'Инвентаризация установленных программ', d: 'Windows составляет список установленных программ и следит за их использованием «для совместимости».', off: 'Пропадёт часть подсказок совместимости для старых программ.' },
    tel_activity: { g: 'tel', r: 'safe', t: 'История действий (Timeline)', d: 'Запись и загрузка в облако того, какие файлы, программы и сайты вы открывали.', off: 'Не будет истории действий и переноса задач между устройствами.' },
    tel_input:    { g: 'tel', r: 'safe', t: 'Сбор образцов набора и рукописного ввода', d: 'Windows отправляет образцы того, как вы печатаете и пишете, для «улучшения распознавания».', off: 'Подсказки при вводе могут стать менее точными.' },
    tel_feedback: { g: 'tel', r: 'safe', t: 'Опросы «Оцените Windows»', d: 'Всплывающие запросы обратной связи.', off: 'Опросы перестанут появляться.' },
    tel_lang:     { g: 'tel', r: 'safe', t: 'Список языков для сайтов', d: 'Браузеры перестанут сообщать сайтам список ваших языков Windows. Это уменьшает «отпечаток» браузера.', off: 'Сайты реже будут сами выбирать язык страницы.' },
    tel_search:   { g: 'tel', r: 'caution', t: 'Bing и Cortana в поиске «Пуска»', d: 'Всё, что вы вводите в поиске «Пуска», уходит в Bing, и вместе с вашими файлами показываются веб-результаты.', off: 'В поиске «Пуска» останутся только ваши программы и файлы, без веб-результатов.' },
  };

  // Пресеты: списки имён служб (регистр не важен) и id твиков.
  // cautious: true — разрешено брать и службы уровня «зависит от вас» (по их рекомендации в базе).
  const HV = ['vmicheartbeat', 'vmickvpexchange', 'vmicrdv', 'vmicshutdown', 'vmictimesync', 'vmicvmsession', 'vmicvss', 'vmicguestinterface', 'HvHost'];
  window.PRESETS = [
    {
      id: 'trackers', icon: 'eye-off', risk: 'safe', riskLabel: 'Безопасно', title: 'Убрать трекеры',
      desc: 'Телеметрия, отчёты об ошибках, история действий, персонализация по диагностике.',
      services: ['DiagTrack', 'dmwappushservice', 'WerSvc', 'WerCplSupport', 'diagnosticshub.standardcollector.service'],
      tweaks: ['tel_core', 'tel_tailored', 'tel_errors', 'tel_appcompat', 'tel_activity', 'tel_input', 'tel_feedback', 'tel_lang'],
    },
    {
      id: 'ads', icon: 'megaphone', risk: 'safe', riskLabel: 'Безопасно', title: 'Убрать рекламу',
      desc: 'Предложения в «Пуске», «Параметрах», на экране блокировки и в проводнике; автоустановка рекламных приложений.',
      services: [],
      tweaks: ['ads_id', 'ads_start', 'ads_settings', 'ads_lock', 'ads_apps', 'ads_explorer', 'ads_setup'],
    },
    {
      id: 'startup', icon: 'power', risk: 'safe', riskLabel: 'Безопасно', title: 'Разгрузить автозагрузку',
      desc: 'Фоновые апдейтеры, лаунчеры и автозапуск браузеров, которые стартуют вместе с Windows и занимают память. Запустить их можно в любой момент вручную.',
      services: [], tweaks: [], startup: true,
    },
    {
      id: 'hardware', icon: 'chip', risk: 'warn', riskLabel: 'Зависит от ПК', title: 'Убрать службы для железа, которого нет',
      desc: 'Факс, смарт-карты, датчики, NFC, шлемы смешанной реальности, Hyper-V-интеграция и др.',
      services: ['Fax', 'SCardSvr', 'ScDeviceEnum', 'SCPolicySvc', 'SEMgrSvc', 'SmsRouter', 'sensrsvc', 'SensorService', 'SensorDataService',
        'SharedRealitySvc', 'spectrum', 'perceptionsimulation', 'MixedRealityOpenXRSvc', 'WalletService', 'PhoneSvc', 'RetailDemo',
        'WFDSConMgrSvc', 'CscService', 'workfolderssvc', 'AxInstSV', ...HV],
      tweaks: [],
    },
    {
      id: 'network', icon: 'network', risk: 'safe', riskLabel: 'Безопасно', title: 'Закрыть лишние сетевые службы',
      desc: 'Удалённый реестр, WebDAV, устаревшая одноранговая сеть, SNMP, LLTD. Меньше открытых «дверей» в системе.',
      services: ['RemoteRegistry', 'RemoteAccess', 'WebClient', 'lltdsvc', 'p2psvc', 'p2pimsvc', 'PNRPsvc', 'PNRPAutoReg', 'SNMPTRAP'],
      tweaks: [],
    },
    {
      id: 'inbound', icon: 'door', risk: 'warn', riskLabel: 'Проверьте', title: 'Закрыть входящие подключения', warn: 'Отключит RDP и общие папки',
      desc: 'Удалённый рабочий стол, общий доступ к вашим папкам и принтерам, UPnP. Ваши исходящие подключения работают как прежде.',
      services: ['TermService', 'SessionEnv', 'LanmanServer', 'SSDPSRV', 'upnphost'], cautious: true,
      tweaks: [],
    },
    {
      id: 'perf', icon: 'gauge', risk: 'warn', riskLabel: 'Зависит от сценария', title: 'Разгрузить память и диск', warn: 'Часть служб зависит от сценария',
      desc: 'Оптимизация доставки, SysMain, карты, геолокация, связь с телефоном, синхронизация почты. Меньше фоновой активности.',
      services: ['DoSvc', 'SysMain', 'MapsBroker', 'lfsvc', 'TrkWks', 'CDPSvc', 'CDPUserSvc', 'OneSyncSvc'], cautious: true,
      tweaks: [],
    },
    {
      id: 'xbox', icon: 'gamepad', risk: 'warn', riskLabel: 'Проверьте Game Pass', title: 'Убрать Xbox-службы', warn: 'Не ставьте, если пользуетесь Game Pass или играми из Microsoft Store',
      desc: 'Переводит службы Xbox Live в ручной запуск. Steam, Epic и другие лаунчеры не затрагиваются.',
      services: ['XblAuthManager', 'XblGameSave', 'XboxGipSvc', 'XboxNetApiSvc'], cautious: true,
      tweaks: [],
    },
  ];
})();
