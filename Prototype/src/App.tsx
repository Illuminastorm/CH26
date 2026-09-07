import { useState, useEffect, type CSSProperties } from "react";

const STARS = Array.from({ length: 80 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: Math.random() > 0.8 ? 2 : 1,
  delay: Math.random() * 3,
  duration: 1 + Math.random() * 2,
}));

const MENU_ITEMS = [
  { id: "play", label: "▶ PLAY GAME", icon: "🎮", color: "btn-pixel", desc: "Jump back into the action" },
  { id: "select", label: "◈ SELECT WORLD THEME", icon: "🗺", color: "btn-pixel-yellow", desc: "Choose your realm" },
  { id: "options", label: "⚙ OPTIONS", icon: "🔧", color: "btn-pixel-blue", desc: "Configure settings" },
  { id: "credits", label: "★ CREDITS", icon: "📜", color: "btn-pixel-green", desc: "Andika + Suraset + William" },
];

const WORLDS = [
  { id: "mushroom", name: "MUSHROOM KINGDOM",  colors: { "--background": "#0a0a1a", "--surface": "#0d0d2a", "--surface-active": "#1a1a5e", "--border": "#3a3a8e", "--accent": "#f8d800", "--accent-dark": "#7a5000", "--muted": "#8888cc", "--highlight": "#76d7ff", "--primary": "#e83030", "--primary-shadow": "#7a0000", "--grid": "#3a3a8e" } },
  { id: "hyrule", name: "HYRULE PLAINS",  colors: { "--background": "#071b18", "--surface": "#10332a", "--surface-active": "#1b5940", "--border": "#518a57", "--accent": "#f5dc73", "--accent-dark": "#725915", "--muted": "#a4c99f", "--highlight": "#8fe2c1", "--primary": "#b35d37", "--primary-shadow": "#61331c", "--grid": "#518a57" } },
  { id: "corneria", name: "CORNERIA SECTOR",  colors: { "--background": "#050b1d", "--surface": "#0b2041", "--surface-active": "#153e70", "--border": "#3975b9", "--accent": "#77e7ff", "--accent-dark": "#155275", "--muted": "#91b5dd", "--highlight": "#f37dff", "--primary": "#e55d91", "--primary-shadow": "#702446", "--grid": "#3975b9" } },
  { id: "dreamland", name: "DREAMLAND",  colors: { "--background": "#24102c", "--surface": "#48234e", "--surface-active": "#754077", "--border": "#bd6cb8", "--accent": "#fff0a5", "--accent-dark": "#8a5b2f", "--muted": "#e0aee1", "--highlight": "#82eff3", "--primary": "#ef7da8", "--primary-shadow": "#8a355b", "--grid": "#bd6cb8" } },
  { id: "kanto", name: "KANTO ROUTE 1",  colors: { "--background": "#152127", "--surface": "#25423f", "--surface-active": "#3c6657", "--border": "#82a15d", "--accent": "#e5ed83", "--accent-dark": "#74772e", "--muted": "#b7cf95", "--highlight": "#a9e7d7", "--primary": "#d65a4a", "--primary-shadow": "#763026", "--grid": "#82a15d" } },
] as const;

type World = (typeof WORLDS)[number];
const WORLD_STORAGE_KEY = "go-tion-selected-world";

const GAME_MODES = [
  { id: "versus", name: "VERSUS", description: "Challenge a local rival", icon: "⚔", color: "#ca5ddd" },
  { id: "practice", name: "PRACTICE", description: "Sharpen your skills", icon: "🎯", color: "#48bd76" },
] as const;

type GameMode = (typeof GAME_MODES)[number];

const CHARACTERS = [
  { id: "nova", name: "NOVA", icon: "🧑‍🚀", color: "#45bfe8" },
  { id: "ember", name: "EMBER", icon: "🧙", color: "#ef704d" },
  { id: "pixel", name: "PIXEL", icon: "🤖", color: "#b76cec" },
  { id: "moss", name: "MOSS", icon: "🧝", color: "#58c87a" },
] as const;

type Character = (typeof CHARACTERS)[number];

type Settings = {
  musicVolume: number;
  effectsVolume: number;
  crtEnabled: boolean;
};

const DEFAULT_SETTINGS: Settings = { musicVolume: 70, effectsVolume: 80, crtEnabled: true };
const SETTINGS_STORAGE_KEY = "go-tion-settings";

type SoundType = "select" | "back" | "countdown" | "fight";
let audioContext: AudioContext | null = null;

function playSound(volume: number, type: SoundType) {
  if (volume <= 0 || typeof window === "undefined") return;

  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") void audioContext.resume();

  const notes: Record<SoundType, [number, number, number]> = {
    select: [460, 720, 0.07],
    back: [340, 180, 0.1],
    countdown: [330, 440, 0.16],
    fight: [240, 880, 0.3],
  };
  const [startFrequency, endFrequency, duration] = notes[type];
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + duration);
  gain.gain.setValueAtTime((volume / 100) * 0.06, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function StarField() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {STARS.map((s) => (
        <div
          key={s.id}
          className="absolute rounded-none bg-white"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.size,
            height: s.size,
            animation: `twinkle ${s.duration}s ${s.delay}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  );
}

function TopBar() {
  const [time, setTime] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTime((p) => p + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const fmt = (n: number) => String(n).padStart(2, "0");
  const mins = fmt(Math.floor(time / 60));
  const secs = fmt(time % 60);

  return (
    <div
      className="flex items-center justify-between px-4 py-2 border-b-4"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        fontSize: 8,
      }}
    >
      <div className="flex items-center gap-6">
        <span className="text-cyan-400">{mins}:{secs}</span>
      </div>
    </div>
  );
}

function Marquee() {
  const text =
    "★ INSERT COIN TO CONTINUE ★  ◈ PRESS START TO BEGIN ★  ★ WELCOME BACK PLAYER ONE ★  🎮 READY PLAYER ONE ★  ";

  return (
    <div
      className="overflow-hidden border-t-4 border-b-4 py-1"
      style={{ borderColor: "var(--accent)", background: "var(--background)", fontSize: 7 }}
    >
      <div className="marquee whitespace-nowrap text-yellow-400">
        {text}{text}
      </div>
    </div>
  );
}

function WorldSelector({ selectedWorld, onClose, onSelect }: { selectedWorld: World; onClose: () => void; onSelect: (world: World) => void }) {
  const [sel, setSel] = useState(() => WORLDS.findIndex((world) => world.id === selectedWorld.id));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") setSel((p) => (p + 1) % WORLDS.length);
      if (e.key === "ArrowUp") setSel((p) => (p - 1 + WORLDS.length) % WORLDS.length);
      if (e.key === "Enter") { onSelect(WORLDS[sel]); onClose(); }
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onSelect, sel]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div
        className="p-8 flex flex-col gap-4"
        style={{ background: "var(--surface)", border: "4px solid var(--accent)", minWidth: 340 }}
      >
        <div className="text-yellow-400 text-center mb-4" style={{ fontSize: 10 }}>
          ◈ SELECT WORLD THEME ◈
        </div>
        {WORLDS.map((w, i) => (
          <button
            key={w.id}
            className="text-left px-4 py-3 transition-all cursor-pointer"
            style={{
              fontSize: 8,
              background: sel === i ? "var(--surface-active)" : "transparent",
              borderLeft: sel === i ? "8px solid var(--accent)" : "8px solid transparent",
              color: sel === i ? "var(--accent)" : "var(--muted)",
            }}
            onClick={() => { setSel(i); onSelect(w); onClose(); }}
            onMouseEnter={() => setSel(i)}
          >
            {sel === i ? "▶ " : "  "}{w.name}
          </button>
        ))}
        <button
          className="mt-4 py-2 btn-pixel text-center"
          style={{ fontSize: 7, padding: "8px 16px" }}
          onClick={onClose}
        >
          ← BACK
        </button>
      </div>
    </div>
  );
}

function GameModeSelector({ onClose, onSelect }: { onClose: () => void; onSelect: (mode: GameMode) => void }) {
  const [selectedMode, setSelectedMode] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) setSelectedMode((current) => (current + 1) % GAME_MODES.length);
      if (e.key === "Enter") onSelect(GAME_MODES[selectedMode]);
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onSelect, selectedMode]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div className="p-7 flex flex-col gap-4" style={{ background: "var(--surface)", border: "4px solid var(--accent)", width: 600, maxWidth: "92vw" }}>
        <div className="text-center" style={{ color: "var(--accent)", fontSize: 10 }}>
          ★ SELECT GAME MODE ★
        </div>
        <div className="grid grid-cols-2 gap-4">
          {GAME_MODES.map((mode, index) => {
            const isSelected = selectedMode === index;
            return (
              <button
                key={mode.id}
                className="relative overflow-hidden text-left p-4 transition-all cursor-pointer"
                style={{
                  minHeight: 190,
                  background: isSelected ? "var(--surface-active)" : "var(--background)",
                  border: isSelected ? "4px solid var(--accent)" : "4px solid var(--border)",
                  boxShadow: isSelected ? `5px 5px 0 ${mode.color}` : "none",
                  transform: isSelected ? "translate(-2px, -2px)" : "none",
                }}
                onMouseEnter={() => setSelectedMode(index)}
                onClick={() => onSelect(mode)}
              >
                <div className="absolute inset-x-0 top-0 h-2" style={{ background: mode.color }} />
                <div className="mt-3 text-center" style={{ fontSize: 48, lineHeight: 1 }}>{mode.icon}</div>
                <div className="mt-4 text-center" style={{ color: isSelected ? "var(--accent)" : "var(--foreground)", fontSize: 8 }}>{mode.name}</div>
                <div className="mt-3 text-center" style={{ color: "var(--highlight)", fontSize: 6, lineHeight: 1.7 }}>{mode.description}</div>
                {isSelected && <div className="absolute bottom-2 left-0 right-0 text-center blink" style={{ color: "var(--accent)", fontSize: 6 }}>▶ PRESS ENTER ◀</div>}
              </button>
            );
          })}
        </div>
        <button className="mt-1 py-2 btn-pixel text-center" style={{ fontSize: 7, padding: "8px 16px" }} onClick={onClose}>
          ← BACK
        </button>
      </div>
    </div>
  );
}

function CharacterSelector({ onBack, onFight, effectsVolume }: { onBack: () => void; onFight: (playerOne: Character, playerTwo: Character) => void; effectsVolume: number }) {
  const [playerOne, setPlayerOne] = useState<Character | null>(null);
  const [playerTwo, setPlayerTwo] = useState<Character | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (!playerOne || !playerTwo) return;
    if (countdown === null) {
      setCountdown(3);
      return;
    }
    if (countdown === 0) {
      playSound(effectsVolume, "fight");
      const launchTimer = window.setTimeout(() => onFight(playerOne, playerTwo), 650);
      return () => window.clearTimeout(launchTimer);
    }
    playSound(effectsVolume, "countdown");
    const timer = window.setTimeout(() => setCountdown((current) => current === null ? null : current - 1), 700);
    return () => window.clearTimeout(timer);
  }, [countdown, effectsVolume, onFight, playerOne, playerTwo]);

  function chooseCharacter(character: Character) {
    if (playerOne?.id === character.id) {
      setPlayerOne(null);
      setPlayerTwo(null);
      setCountdown(null);
    } else if (playerTwo?.id === character.id) {
      setPlayerTwo(null);
      setCountdown(null);
    } else if (!playerOne) {
      setPlayerOne(character);
      setPlayerTwo(null);
      setCountdown(null);
    } else if (playerOne.id !== character.id) {
      setPlayerTwo(character);
    }
  }

  function changeFighters() {
    setPlayerTwo(null);
    setCountdown(null);
  }

  const selectingPlayer = playerOne && !playerTwo ? "P2" : "P1";

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.88)" }}>
      <div className="relative p-6 flex flex-col gap-4" style={{ background: "var(--surface)", border: "4px solid var(--accent)", width: 720, maxWidth: "94vw" }}>
        <div className="flex items-center justify-between" style={{ fontSize: 9, color: "var(--accent)" }}>
          <span>★ 1V1 CHARACTER SELECT ★</span>
          <span className="blink" style={{ fontSize: 6, color: "var(--highlight)" }}>SELECT {selectingPlayer}</span>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-5 py-2">
          <div className="text-center p-3" style={{ minHeight: 95, border: "3px solid var(--border)", background: playerOne ? "var(--surface-active)" : "var(--background)" }}>
            <div style={{ color: "var(--highlight)", fontSize: 7 }}>PLAYER 1</div>
            <div className="mt-2" style={{ color: playerOne ? "var(--accent)" : "var(--muted)", fontSize: 8 }}>{playerOne ? `${playerOne.icon} ${playerOne.name}` : "CHOOSE FIGHTER"}</div>
          </div>
          <div className="text-center" style={{ color: "var(--primary)", fontSize: 16 }}>VS</div>
          <div className="text-center p-3" style={{ minHeight: 95, border: "3px solid var(--border)", background: playerTwo ? "var(--surface-active)" : "var(--background)" }}>
            <div style={{ color: "var(--highlight)", fontSize: 7 }}>PLAYER 2</div>
            <div className="mt-2" style={{ color: playerTwo ? "var(--accent)" : "var(--muted)", fontSize: 8 }}>{playerTwo ? `${playerTwo.icon} ${playerTwo.name}` : "CHOOSE FIGHTER"}</div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {CHARACTERS.map((character) => {
            const selectedBy = playerOne?.id === character.id ? "P1" : playerTwo?.id === character.id ? "P2" : null;
            return (
              <button
                key={character.id}
                className="relative overflow-hidden p-3 cursor-pointer transition-all"
                disabled={countdown !== null}
                style={{ minHeight: 130, background: "var(--background)", border: `3px solid ${selectedBy ? "var(--accent)" : "var(--border)"}`, boxShadow: selectedBy ? `4px 4px 0 ${character.color}` : "none", opacity: countdown !== null ? 0.55 : 1 }}
                onClick={() => chooseCharacter(character)}
              >
                <div className="absolute inset-x-0 top-0 h-2" style={{ background: character.color }} />
                <div className="mt-3" style={{ fontSize: 34, lineHeight: 1 }}>{character.icon}</div>
                <div className="mt-3" style={{ color: "var(--foreground)", fontSize: 7 }}>{character.name}</div>
                {selectedBy && <div className="absolute bottom-2 inset-x-0" style={{ color: "var(--accent)", fontSize: 6 }}>{selectedBy} READY</div>}
              </button>
            );
          })}
        </div>

        <div className="text-center" style={{ color: "var(--muted)", fontSize: 6 }}>
          CLICK A SELECTED FIGHTER TO DESELECT
        </div>

        <button className="mt-1 py-2 btn-pixel text-center" style={{ fontSize: 7, padding: "8px 16px" }} onClick={onBack}>
          ← BACK TO MODES
        </button>

        {countdown !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: "rgba(5,5,18,0.86)" }}>
            <div className="glow-text" style={{ color: "var(--accent)", fontSize: 76, lineHeight: 1 }}>
              {countdown === 0 ? "FIGHT!" : countdown}
            </div>
            <div className="mt-5" style={{ color: "var(--highlight)", fontSize: 8 }}>
              {playerOne?.name} VS {playerTwo?.name}
            </div>
            <button className="mt-6 py-2 px-4 btn-pixel" style={{ fontSize: 6 }} onClick={changeFighters}>
              CHANGE FIGHTERS
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FightingMode({ playerOne, playerTwo, onExit }: { playerOne: Character; playerTwo: Character; onExit: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.88)" }}>
      <div className="p-6 flex flex-col gap-5" style={{ background: "var(--background)", border: "4px solid var(--accent)", width: 760, maxWidth: "94vw" }}>
        <div className="flex items-center justify-between" style={{ fontSize: 8 }}>
          <span style={{ color: "var(--highlight)" }}>ROUND 1</span>
          <span className="blink" style={{ color: "var(--accent)" }}>FIGHT!</span>
          <span style={{ color: "var(--highlight)" }}>00:99</span>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
          <div className="text-center">
            <div className="h-4" style={{ background: "var(--surface-active)", border: "2px solid var(--border)" }}>
              <div className="h-full" style={{ width: "100%", background: playerOne.color }} />
            </div>
            <div className="mt-3" style={{ color: "var(--accent)", fontSize: 9 }}>{playerOne.name}</div>
            <div className="mt-6 float" style={{ fontSize: 96, lineHeight: 1 }}>{playerOne.icon}</div>
            <div className="mt-4" style={{ color: "var(--highlight)", fontSize: 6 }}>PLAYER 1</div>
          </div>
          <div style={{ color: "var(--primary)", fontSize: 20 }}>VS</div>
          <div className="text-center">
            <div className="h-4" style={{ background: "var(--surface-active)", border: "2px solid var(--border)" }}>
              <div className="h-full ml-auto" style={{ width: "100%", background: playerTwo.color }} />
            </div>
            <div className="mt-3" style={{ color: "var(--accent)", fontSize: 9 }}>{playerTwo.name}</div>
            <div className="mt-6 float" style={{ fontSize: 96, lineHeight: 1, animationDelay: "0.4s" }}>{playerTwo.icon}</div>
            <div className="mt-4" style={{ color: "var(--highlight)", fontSize: 6 }}>PLAYER 2</div>
          </div>
        </div>
        <div className="text-center py-3" style={{ borderTop: "3px solid var(--border)", color: "var(--muted)", fontSize: 6 }}>
          PLAYER 1: A ATTACK · PLAYER 2: L ATTACK
        </div>
        <button className="py-2 btn-pixel text-center" style={{ fontSize: 7 }} onClick={onExit}>
          ← EXIT FIGHT
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({ settings, onChange, onClose }: { settings: Settings; onChange: (settings: Settings) => void; onClose: () => void }) {
  const updateVolume = (key: "musicVolume" | "effectsVolume", value: number) => onChange({ ...settings, [key]: value });

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div className="p-7 flex flex-col gap-6" style={{ background: "var(--surface)", border: "4px solid var(--accent)", width: 480, maxWidth: "92vw" }}>
        <div className="text-center" style={{ color: "var(--accent)", fontSize: 10 }}>⚙ SETTINGS ⚙</div>
        {[
          { key: "musicVolume" as const, label: "MUSIC VOLUME" },
          { key: "effectsVolume" as const, label: "SFX VOLUME" },
        ].map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-3" style={{ color: "var(--foreground)", fontSize: 7 }}>
            <span className="flex justify-between"><span>{label}</span><span style={{ color: "var(--accent)" }}>{settings[key]}%</span></span>
            <input
              type="range"
              min="0"
              max="100"
              value={settings[key]}
              onChange={(event) => updateVolume(key, Number(event.target.value))}
              style={{ accentColor: "var(--accent)" }}
            />
          </label>
        ))}
        <div className="flex items-center justify-between" style={{ color: "var(--foreground)", fontSize: 7 }}>
          <span>CRT SCREEN EFFECT</span>
          <button
            className="px-4 py-2 cursor-pointer"
            style={{ background: settings.crtEnabled ? "var(--accent)" : "var(--surface-active)", color: settings.crtEnabled ? "var(--background)" : "var(--muted)", border: "2px solid var(--border)", fontSize: 7 }}
            onClick={() => onChange({ ...settings, crtEnabled: !settings.crtEnabled })}
          >
            {settings.crtEnabled ? "ON" : "OFF"}
          </button>
        </div>
        <button className="py-2 btn-pixel text-center" style={{ fontSize: 7 }} onClick={onClose}>← BACK</button>
      </div>
    </div>
  );
}

function MenuPanel({
  selectedIdx,
  setSelectedIdx,
  onSelect,
}: {
  selectedIdx: number;
  setSelectedIdx: (i: number) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3" style={{ width: 480 }}>
      {MENU_ITEMS.map((item, i) => (
        <button
          key={item.id}
          className={`text-left px-4 py-4 transition-all cursor-pointer relative ${item.color}`}
          style={{ fontSize: 8, lineHeight: 2 }}
          onMouseEnter={() => setSelectedIdx(i)}
          onClick={() => onSelect(item.id)}
        >
          {selectedIdx === i && (
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-white blink" style={{ fontSize: 10 }}>
              ▶
            </span>
          )}
          <span style={{ paddingLeft: selectedIdx === i ? 12 : 0 }}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function InfoPanel({ item }: { item: (typeof MENU_ITEMS)[0] | null }) {
  if (!item) return null;
  return (
    <div
      className="p-6 flex flex-col gap-4 items-center justify-center text-center"
      style={{
        background: "var(--surface)",
        border: "4px solid var(--border)",
        minHeight: 180,
        minWidth: 220,
      }}
    >
      <div className="text-4xl float">{item.icon}</div>
      <div className="text-yellow-400" style={{ fontSize: 9 }}>{item.label.replace(/^[▶✦◈⚙♛★]\s/, "")}</div>
      <div className="text-blue-300" style={{ fontSize: 7, lineHeight: 2 }}>
        {item.desc}
      </div>
      <div className="mt-2 text-gray-500 blink" style={{ fontSize: 6 }}>
        PRESS ↵ TO SELECT
      </div>
    </div>
  );
}


function BottomBar() {
  return (
    <div
      className="flex items-center justify-between px-4 py-2"
      style={{ background: "var(--surface)", borderTop: "4px solid var(--border)", fontSize: 7 }}
    >
      <div className="flex gap-4 text-gray-400">
        <span><span className="text-yellow-400">↑↓</span> NAVIGATE</span>
        <span><span className="text-yellow-400">↵</span> SELECT</span>
        <span><span className="text-yellow-400">ESC</span> BACK</span>
      </div>
      <div className="flex gap-4 text-gray-400">
        <span className="text-red-400">● A</span>
        <span className="text-blue-400">● B</span>
        <span className="text-green-400">● C</span>
        <span className="text-yellow-400">★ START</span>
      </div>
    </div>
  );
}

export default function App() {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [showTitle, setShowTitle] = useState(true);
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode | null>(null);
  const [fighters, setFighters] = useState<{ playerOne: Character; playerTwo: Character } | null>(null);
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [selectedWorld, setSelectedWorld] = useState<World>(() => {
    const saved = localStorage.getItem(WORLD_STORAGE_KEY);
    return WORLDS.find((world) => world.id === saved) ?? WORLDS[0];
  });
  const themeStyle = selectedWorld.colors as CSSProperties & Record<`--${string}`, string>;

  useEffect(() => {
    localStorage.setItem(WORLD_STORAGE_KEY, selectedWorld.id);
  }, [selectedWorld]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const t = setTimeout(() => setShowTitle(false), 2000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeModal) return;
      if (e.key === "ArrowDown") setSelectedIdx((p) => (p + 1) % MENU_ITEMS.length);
      if (e.key === "ArrowUp") setSelectedIdx((p) => (p - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
      if (e.key === "Enter") handleSelect(MENU_ITEMS[selectedIdx].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIdx, activeModal]);

  function handleSelect(id: string) {
    if (id === "select") setActiveModal("world");
    else if (id === "play") setActiveModal("game-mode");
    else setActiveModal(id);
  }

  function handleGameModeSelect(mode: GameMode) {
    setSelectedGameMode(mode);
    setActiveModal(mode.id === "versus" ? "character-select" : null);
  }

  function handleFightStart(playerOne: Character, playerTwo: Character) {
    setFighters({ playerOne, playerTwo });
    setActiveModal("fighting");
  }

  return (
    <div
      className={`${settings.crtEnabled ? "crt " : ""}flicker size-full flex flex-col relative overflow-hidden`}
      style={{ ...themeStyle, fontFamily: "'Press Start 2P', monospace", background: "var(--background)" }}
      onClickCapture={(event) => {
        const button = (event.target as HTMLElement).closest("button");
        if (button) playSound(settings.effectsVolume, button.textContent?.includes("BACK") || button.textContent?.includes("EXIT") ? "back" : "select");
      }}
      onPointerUpCapture={(event) => {
        if ((event.target as HTMLInputElement).type === "range") playSound(settings.effectsVolume, "select");
      }}
    >
      <StarField />

      {/* Retro grid background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-10"
        style={{
          backgroundImage:
            "linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {showTitle && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center" style={{ background: "var(--background)" }}>
          <div className="text-yellow-400 glow-text text-center" style={{ fontSize: 20, lineHeight: 1.6 }}>
            ★ Andescendants ★
          </div>
          <div className="text-white mt-2 blink" style={{ fontSize: 8 }}>LOADING…</div>
        </div>
      )}

      <TopBar />
      <Marquee />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden relative flex-col">
        {/* Logo — fixed in the center of the space */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center flex flex-col items-center gap-3">
            <div
              className="glow-text text-yellow-400"
              style={{ fontSize: "clamp(60px, 3vw, 42px)", letterSpacing: 2, lineHeight: 1.6, textShadow: "4px 4px 0 var(--accent-dark)" }}
            >
              ★ GO-TION ★
            </div>
            <div style={{ fontSize: 7, letterSpacing: 4, color: "var(--highlight)" }}>
              VERSION 0.0.1
            </div>
            <div className="flex gap-2 mt-1">
              {["var(--primary)", "var(--accent)", "var(--highlight)", "var(--border)"].map((c) => (
                <div key={c} style={{ width: 8, height: 8, background: c }} />
              ))}
            </div>
          </div>
        </div>

        {/* Buttons — pinned to the bottom */}
        <div className="flex justify-center pb-10">
          <MenuPanel
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            onSelect={handleSelect}
          />
        </div>
      </div>


      <BottomBar />

      {/* World selector modal */}
      {activeModal === "world" && (
        <WorldSelector selectedWorld={selectedWorld} onSelect={setSelectedWorld} onClose={() => setActiveModal(null)} />
      )}

      {activeModal === "game-mode" && (
        <GameModeSelector onSelect={handleGameModeSelect} onClose={() => setActiveModal(null)} />
      )}

      {activeModal === "character-select" && (
        <CharacterSelector onBack={() => setActiveModal("game-mode")} onFight={handleFightStart} effectsVolume={settings.effectsVolume} />
      )}

      {activeModal === "fighting" && fighters && (
        <FightingMode playerOne={fighters.playerOne} playerTwo={fighters.playerTwo} onExit={() => setActiveModal(null)} />
      )}

      {activeModal === "options" && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setActiveModal(null)} />
      )}

      {/* Generic modal for other menu items */}
      {activeModal && activeModal !== "world" && activeModal !== "game-mode" && activeModal !== "character-select" && activeModal !== "fighting" && activeModal !== "options" && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.85)" }}
          onClick={() => setActiveModal(null)}
        >
          <div
            className="p-8 text-center flex flex-col gap-4"
            style={{ background: "var(--surface)", border: "4px solid var(--accent)", minWidth: 280 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-yellow-400" style={{ fontSize: 10 }}>
              {MENU_ITEMS.find((m) => m.id === activeModal)?.icon}
            </div>
            <div className="text-white" style={{ fontSize: 9 }}>
              {MENU_ITEMS.find((m) => m.id === activeModal)?.label}
            </div>
            <div className="text-blue-300" style={{ fontSize: 7, lineHeight: 2 }}>
              {MENU_ITEMS.find((m) => m.id === activeModal)?.desc}
            </div>
            <button
              className="btn-pixel mt-4 py-2 px-6"
              style={{ fontSize: 7 }}
              onClick={() => setActiveModal(null)}
            >
              ← BACK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
