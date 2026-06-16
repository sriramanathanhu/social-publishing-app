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
];

export const DUB_LANGUAGE_CODES = DUB_LANGUAGES.map((l) => l.code);
export const DUB_VOICE_IDS = DUB_LANGUAGES.flatMap((l) =>
	l.voices.map((v) => v.id),
);
