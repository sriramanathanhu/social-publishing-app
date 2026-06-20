/**
 * Target languages and Edge-TTS voices offered by the dub feature. Edge-TTS is
 * free and CPU-light; these voice ids are what the dubber-service passes to it.
 */

export type DubVoice = { id: string; label: string };
export type DubLanguage = { code: string; label: string; voices: DubVoice[] };

export const DUB_LANGUAGES: DubLanguage[] = [
	{
		code: "gu",
		label: "Gujarati",
		voices: [
			{ id: "gu-IN-NiranjanNeural", label: "Niranjan (male)" },
			{ id: "gu-IN-DhwaniNeural", label: "Dhwani (female)" },
		],
	},
	{
		code: "hi",
		label: "Hindi",
		voices: [
			{ id: "hi-IN-MadhurNeural", label: "Madhur (male)" },
			{ id: "hi-IN-SwaraNeural", label: "Swara (female)" },
		],
	},
	{
		code: "ta",
		label: "Tamil",
		voices: [
			{ id: "ta-IN-ValluvarNeural", label: "Valluvar (male)" },
			{ id: "ta-IN-PallaviNeural", label: "Pallavi (female)" },
		],
	},
	{
		code: "te",
		label: "Telugu",
		voices: [
			{ id: "te-IN-MohanNeural", label: "Mohan (male)" },
			{ id: "te-IN-ShrutiNeural", label: "Shruti (female)" },
		],
	},
	{
		code: "kn",
		label: "Kannada",
		voices: [
			{ id: "kn-IN-GaganNeural", label: "Gagan (male)" },
			{ id: "kn-IN-SapnaNeural", label: "Sapna (female)" },
		],
	},
	{
		code: "mr",
		label: "Marathi",
		voices: [
			{ id: "mr-IN-ManoharNeural", label: "Manohar (male)" },
			{ id: "mr-IN-AarohiNeural", label: "Aarohi (female)" },
		],
	},
	{
		code: "bn",
		label: "Bengali",
		voices: [
			{ id: "bn-IN-BashkarNeural", label: "Bashkar (male)" },
			{ id: "bn-IN-TanishaaNeural", label: "Tanishaa (female)" },
		],
	},
	{
		code: "ml",
		label: "Malayalam",
		voices: [
			{ id: "ml-IN-MidhunNeural", label: "Midhun (male)" },
			{ id: "ml-IN-SobhanaNeural", label: "Sobhana (female)" },
		],
	},
	{
		// Edge-TTS has no Bhojpuri voice; Bhojpuri uses Devanagari, so we
		// synthesize it with the Hindi voice (reads the same script well).
		code: "bho",
		label: "Bhojpuri",
		voices: [
			{ id: "hi-IN-MadhurNeural", label: "Madhur (Hindi voice, male)" },
			{ id: "hi-IN-SwaraNeural", label: "Swara (Hindi voice, female)" },
		],
	},
	{
		code: "ru",
		label: "Russian",
		voices: [
			{ id: "ru-RU-DmitryNeural", label: "Dmitry (male)" },
			{ id: "ru-RU-SvetlanaNeural", label: "Svetlana (female)" },
		],
	},
	{
		code: "fr",
		label: "French",
		voices: [
			{ id: "fr-FR-HenriNeural", label: "Henri (male)" },
			{ id: "fr-FR-DeniseNeural", label: "Denise (female)" },
		],
	},
	{
		code: "es",
		label: "Spanish",
		voices: [
			{ id: "es-ES-AlvaroNeural", label: "Alvaro (male)" },
			{ id: "es-ES-ElviraNeural", label: "Elvira (female)" },
		],
	},
	{
		code: "ko",
		label: "Korean",
		voices: [
			{ id: "ko-KR-InJoonNeural", label: "InJoon (male)" },
			{ id: "ko-KR-SunHiNeural", label: "SunHi (female)" },
		],
	},
	{
		code: "nl",
		label: "Dutch",
		voices: [
			{ id: "nl-NL-MaartenNeural", label: "Maarten (male)" },
			{ id: "nl-NL-ColetteNeural", label: "Colette (female)" },
		],
	},
	{
		code: "zh-CN",
		label: "Chinese (Mandarin)",
		voices: [
			{ id: "zh-CN-YunxiNeural", label: "Yunxi (male)" },
			{ id: "zh-CN-XiaoxiaoNeural", label: "Xiaoxiao (female)" },
		],
	},
];

export const DUB_LANGUAGE_CODES = DUB_LANGUAGES.map((l) => l.code);
export const DUB_VOICE_IDS = DUB_LANGUAGES.flatMap((l) =>
	l.voices.map((v) => v.id),
);
