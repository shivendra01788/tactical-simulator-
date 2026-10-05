'use client';
import { MapContainer, TileLayer, Marker, useMapEvents, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useStore } from '../app/store/useStore'; // casing must match the real filename
import L from 'leaflet';

// Full class strings per kind so Tailwind can detect them.
const STYLES = {
  hostile: {
    box: 'border-2 border-red-500 rotate-45 bg-red-500/20 shadow-[0_0_10px_rgba(239,68,68,0.8)]',
    dot: 'bg-red-400',
    text: 'text-red-400',
  },
  suspect: {
    box: 'border-2 border-amber-400 rotate-45 bg-amber-500/20 shadow-[0_0_10px_rgba(251,191,36,0.8)]',
    dot: 'bg-amber-300',
    text: 'text-amber-400',
  },
  friendly: {
    box: 'border-2 border-green-400 bg-green-500/20 shadow-[0_0_10px_rgba(74,222,128,0.8)]',
    dot: 'bg-green-300',
    text: 'text-green-400',
  },
  decoy: {
    box: 'border-2 border-dashed border-gray-400 rotate-45 bg-gray-500/20',
    dot: 'bg-gray-300',
    text: 'text-gray-400',
  },
};

const iconCache = {};
function iconFor(kind, label) {
  const k = STYLES[kind] ? kind : 'hostile';
  const key = `${k}|${label}`;
  if (!iconCache[key]) {
    const s = STYLES[k];
    iconCache[key] = L.divIcon({
      className: 'bg-transparent',
      html: `
        <div class="relative flex items-center justify-center w-8 h-8">
          <div class="absolute w-6 h-6 ${s.box}"></div>
          <div class="absolute w-1 h-1 ${s.dot} rounded-full"></div>
          <span class="absolute -bottom-5 text-[10px] font-mono ${s.text} font-bold tracking-widest whitespace-nowrap">${label || ''}</span>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }
  return iconCache[key];
}

// Only the ground unit can move. The store and server enforce this too.
function ClickHandler() {
  const moveUnit = useStore((state) => state.moveUnit);
  const role = useStore((state) => state.role);

  useMapEvents({
    click(e) {
      if (role === 'unit') moveUnit(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Wraps onto two lines on narrow phone screens instead of running off the edge.
function Legend() {
  const items = [
    ['hostile', 'HOSTILE'],
    ['suspect', 'SUSPECT'],
    ['decoy', 'DECOY'],
    ['friendly', 'FRIENDLY'],
  ];
  return (
    <div className="absolute bottom-2 left-2 md:bottom-3 md:left-3 z-[500] max-w-[calc(100%-1rem)] border border-green-900 bg-black/80 px-2 md:px-3 py-1 md:py-2 font-mono text-[10px] flex flex-wrap gap-x-3 md:gap-x-4 gap-y-0.5">
      {items.map(([kind, name]) => (
        <span key={kind} className={`${STYLES[kind].text} tracking-wider md:tracking-widest`}>
          ■ {name}
        </span>
      ))}
    </div>
  );
}

export default function TacticalMap() {
  const entities = useStore((state) => state.entities);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[28.5961, 77.2023]}
        zoom={15}
        style={{ height: '100%', width: '100%', background: '#0a0a0a', isolation: 'isolate' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          attribution="Tiles &copy; Esri"
        />
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          opacity={0.1}
          className="mix-blend-overlay filter invert grayscale"
        />

        <ClickHandler />

        {Object.entries(entities).map(([id, pos]) => (
          <Marker key={id} position={[pos.lat, pos.lng]} icon={iconFor(pos.kind, pos.label)}>
            <Popup className="font-mono text-xs">
              <strong>ENTITY: {id.toUpperCase()}</strong>
              <br />
              TYPE: {(pos.kind || 'unknown').toUpperCase()}
              <br />
              LAT: {pos.lat.toFixed(5)}
              <br />
              LON: {pos.lng.toFixed(5)}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <Legend />
    </div>
  );
}