/**
 * 护眼主题预设
 *
 * 逐字取自 zotero-eye-care 插件 (作者 ZhaoPuEE, v1.1.0-beta.1) 的
 * content/theme-presets.js —— https://github.com/ZhaoPuEE/zotero-eye-care
 *
 * 原插件通过 Zotero.SyncedSettings.set(libraryID, "readerCustomThemes", themes)
 * 把这四个主题写进 Zotero 设置。这里改成直接通过 reader 构造函数的
 * customThemes 选项注入 —— 格式完全一致，因为 reader 本来就认这个结构：
 *   src/common/reader.js:198  let themes = [...DEFAULT_THEMES, ...(options.customThemes || [])];
 */
window.EYE_CARE_THEMES = [
	{
		id: 'zotero-eye-care-green',
		label: '淡豆沙绿',
		background: '#DCEAD8',
		foreground: '#26352A',
		invertImages: false,
	},
	{
		id: 'zotero-eye-care-warm-yellow',
		label: '暖米黄',
		background: '#F5E9CE',
		foreground: '#40372A',
		invertImages: false,
	},
	{
		id: 'zotero-eye-care-mist-blue',
		label: '雾蓝灰',
		background: '#E3EBF1',
		foreground: '#293742',
		invertImages: false,
	},
	{
		id: 'zotero-eye-care-night-gray',
		label: '深灰夜读',
		background: '#252A2E',
		foreground: '#D7DDD9',
		invertImages: false,
	},
];
