// ============================================================================
//  Space Engineers Build Planner — game data
//  ---------------------------------------------------------------------------
//  Values are vanilla Space Engineers (1.x). Thruster figures come from the
//  wiki's Thruster Comparison table (spaceengineers.wiki.gg) and the
//  343N/spaceengineers-thrust-calc project; most block masses are from the wiki
//  infoboxes. Entries flagged `approx: true` were taken from older game data
//  and may differ slightly from the current game — edit them here, or override
//  any block's mass in the app ("Block library" → edit).
//
//  Units: mass kg · force N · power MW · volume L · size in grid cells [x,y,z]
//  Local block axes: +Y = block "up", -Z = block "forward".
//  Thrusters: the nozzle/exhaust is at local +Z, so the thrust pushes the ship
//  toward local -Z. Sizes for thrusters are [width, height, length-along-thrust].
// ============================================================================

export const G0 = 9.81; // m/s² per 1 g, as used by Space Engineers

export const GRID = {
  L: { name: 'Large grid', cell: 2.5 },
  S: { name: 'Small grid', cell: 0.5 },
};

// Thruster effectiveness vs. atmospheric density ("planetary influence").
// Linear between (minInfluence → effAtMin) and (maxInfluence → effAtMax), clamped.
export const THRUSTER_TYPES = {
  ion:       { name: 'Ion',         color: 0x58a6ff, minInf: 0.0, maxInf: 1.0, effMin: 1.0, effMax: 0.2, needsAtmo: true },
  atmo:      { name: 'Atmospheric', color: 0xf0883e, minInf: 0.3, maxInf: 1.0, effMin: 0.0, effMax: 1.0, needsAtmo: true },
  hydrogen:  { name: 'Hydrogen',    color: 0xff6b6b, minInf: 0.0, maxInf: 1.0, effMin: 1.0, effMax: 1.0, needsAtmo: false },
  prototech: { name: 'Prototech',   color: 0xd2a8ff, minInf: 0.0, maxInf: 1.0, effMin: 1.0, effMax: 0.3, needsAtmo: true },
};

export function thrusterEffectiveness(type, airDensity) {
  const t = THRUSTER_TYPES[type];
  if (!t) return 1;
  const d = Math.max(0, airDensity);
  if (t.needsAtmo && d <= 0) return t.minInf <= 0 ? t.effMin : 0;
  if (d <= t.minInf) return t.effMin;
  if (d >= t.maxInf) return t.effMax;
  const f = (d - t.minInf) / (t.maxInf - t.minInf);
  return t.effMin + (t.effMax - t.effMin) * f;
}

// Planet presets. density = air density at the surface (1 = Earth sea level).
// Air density falls roughly linearly to 0 at the top of the atmosphere, so use
// the "air density" slider to model flight at altitude.
// R = surface radius (km), gravAlt = altitude where gravity drops below 0.05 g (km),
// atmoAlt = height of the atmosphere (km). Wiki values; Alien & Triton gravAlt/atmoAlt are estimates.
export const PLANETS = [
  { id: 'earth',  name: 'EarthLike',      g: 1.00, density: 1.0, R: 60,  gravAlt: 42.86, atmoAlt: 14.4 },
  { id: 'mars',   name: 'Mars',           g: 0.90, density: 1.0, R: 60,  gravAlt: 39.31, atmoAlt: 14.4 },
  { id: 'alien',  name: 'Alien',          g: 1.10, density: 1.0, R: 60,  gravAlt: 44.3,  atmoAlt: 14.4 },
  { id: 'triton', name: 'Triton',         g: 1.00, density: 1.0, R: 40,  gravAlt: 28.7,  atmoAlt: 9.6 },
  { id: 'pertam', name: 'Pertam',         g: 1.20, density: 0.8, R: 30,  gravAlt: 18.51, atmoAlt: 4.7 },
  { id: 'moon',   name: 'Moon',           g: 0.25, density: 0.0, R: 9.5, gravAlt: 2.678, atmoAlt: 0 },
  { id: 'europa', name: 'Europa',         g: 0.25, density: 1.0, R: 9.5, gravAlt: 3.15,  atmoAlt: 1.15 },
  { id: 'titan',  name: 'Titan',          g: 0.25, density: 1.0, R: 9.5, gravAlt: 3.0,   atmoAlt: 0.6 },
  { id: 'space',  name: 'Deep space (0 g)', g: 0.00, density: 0.0 },
  { id: 'custom', name: 'Custom…',        g: 1.00, density: 1.0 },
];

// Cargo items: kg per litre = 1 / (litres per kg). Ores are 0.37 L/kg.
export const ITEMS = [
  { id: 'ore',      name: 'Any ore / Ice / Stone', lPerKg: 0.37 },
  { id: 'gravel',   name: 'Gravel',                lPerKg: 0.37 },
  { id: 'iron',     name: 'Iron ingot',            lPerKg: 0.127 },
  { id: 'nickel',   name: 'Nickel ingot',          lPerKg: 0.112 },
  { id: 'cobalt',   name: 'Cobalt ingot',          lPerKg: 0.112 },
  { id: 'silicon',  name: 'Silicon wafer',         lPerKg: 0.429 },
  { id: 'magnes',   name: 'Magnesium powder',      lPerKg: 0.575 },
  { id: 'silver',   name: 'Silver ingot',          lPerKg: 0.095 },
  { id: 'gold',     name: 'Gold ingot',            lPerKg: 0.052 },
  { id: 'uranium',  name: 'Uranium ingot',         lPerKg: 0.052 },
  { id: 'platinum', name: 'Platinum ingot',        lPerKg: 0.047 },
  { id: 'steel',    name: 'Steel plates',          lPerKg: 3 / 20 },
  { id: 'constr',   name: 'Construction comps',    lPerKg: 2 / 8 },
  { id: 'custom',   name: 'Custom density…',       lPerKg: 0.37 },
];

export const INVENTORY_MULTIPLIERS = [1, 3, 5, 10];

export const CATEGORIES = [
  { id: 'armor',     name: 'Armor' },
  { id: 'thrust',    name: 'Thrusters' },
  { id: 'power',     name: 'Power' },
  { id: 'storage',   name: 'Cargo & Tanks' },
  { id: 'control',   name: 'Control & Comms' },
  { id: 'tools',     name: 'Tools & Production' },
  { id: 'weapons',   name: 'Weapons' },
  { id: 'conveyor',  name: 'Conveyors' },
  { id: 'mech',      name: 'Mechanical' },
  { id: 'misc',      name: 'Utility & Interior' },
  { id: 'custom',    name: 'Custom blocks' },
];

export const CAT_COLORS = {
  armor: 0x8b949e, thrust: 0xf0883e, power: 0xe3b341, storage: 0x3fb950,
  control: 0x58a6ff, tools: 0xdb61a2, conveyor: 0xd4a72c, weapons: 0xf85149, mech: 0xa371f7, misc: 0x6e7681, custom: 0x39c5cf,
};

// ---------------------------------------------------------------------------
// Block definitions.  B(key, name, cat, shape, largeSpec, smallSpec, extra)
// spec: { s:[x,y,z], m:mass, inv:L (general cargo), invOre:L (ore-only, e.g. drills),
//         thrust:{type, f:N, p:MW, h2:L/s}, pOut:MW, store:MWh, h2:L, o2:L, approx }
// ---------------------------------------------------------------------------
const RAW = [];
function B(key, name, cat, shape, L, S, extra = {}) { RAW.push({ key, name, cat, shape, L, S, ...extra }); }

// Armor ---------------------------------------------------------------------
B('LightArmor',        'Light Armor Block',        'armor', 'cube',      { s:[1,1,1], m:500 },  { s:[1,1,1], m:20 });
B('LightArmorSlope',   'Light Armor Slope',        'armor', 'slope',     { s:[1,1,1], m:260, approx:1 }, { s:[1,1,1], m:20, approx:1 });
B('LightArmorCorner',  'Light Armor Corner',       'armor', 'corner',    { s:[1,1,1], m:80, approx:1 },  { s:[1,1,1], m:20, approx:1 });
B('LightArmorInvCorner','Light Armor Inv. Corner', 'armor', 'invcorner', { s:[1,1,1], m:420, approx:1 }, { s:[1,1,1], m:20, approx:1 });
B('HeavyArmor',        'Heavy Armor Block',        'armor', 'cube',      { s:[1,1,1], m:3300 }, { s:[1,1,1], m:112 }, { heavy:1 });
B('HeavyArmorSlope',   'Heavy Armor Slope',        'armor', 'slope',     { s:[1,1,1], m:1650, approx:1 }, { s:[1,1,1], m:66, approx:1 }, { heavy:1 });
B('HeavyArmorCorner',  'Heavy Armor Corner',       'armor', 'corner',    { s:[1,1,1], m:560, approx:1 },  { s:[1,1,1], m:46, approx:1 }, { heavy:1 });
B('HeavyArmorInvCorner','Heavy Armor Inv. Corner', 'armor', 'invcorner', { s:[1,1,1], m:2800, approx:1 }, { s:[1,1,1], m:86, approx:1 }, { heavy:1 });
B('LightHalf',         'Light Armor Half Block',   'armor', 'half',      { s:[1,1,1], m:250, approx:1 },  { s:[1,1,1], m:10, approx:1 });
B('HeavyHalf',         'Heavy Armor Half Block',   'armor', 'half',      { s:[1,1,1], m:1650, approx:1 }, { s:[1,1,1], m:56, approx:1 }, { heavy:1 });
B('LightSlope2Base',   'Light Armor Slope 2x1 Base','armor','slope2base',{ s:[1,1,1], m:380, approx:1 },  { s:[1,1,1], m:20, approx:1 });
B('LightSlope2Tip',    'Light Armor Slope 2x1 Tip', 'armor','slope2tip', { s:[1,1,1], m:140, approx:1 },  { s:[1,1,1], m:20, approx:1 });
B('HeavySlope2Base',   'Heavy Armor Slope 2x1 Base','armor','slope2base',{ s:[1,1,1], m:2510, approx:1 }, { s:[1,1,1], m:86, approx:1 }, { heavy:1 });
B('HeavySlope2Tip',    'Heavy Armor Slope 2x1 Tip', 'armor','slope2tip', { s:[1,1,1], m:736, approx:1 },  { s:[1,1,1], m:46, approx:1 }, { heavy:1 });
B('LightPanel',        'Light Armor Panel',        'armor', 'panel',     { s:[1,1,1], m:125, approx:1 },  { s:[1,1,1], m:5, approx:1 });
B('HeavyPanel',        'Heavy Armor Panel',        'armor', 'panel',     { s:[1,1,1], m:825, approx:1 },  { s:[1,1,1], m:28, approx:1 }, { heavy:1 });

// Thrusters -----------------------------------------------------------------
B('IonS',      'Ion Thruster',                 'thrust', 'thruster',
  { s:[1,1,2], m:4380,  thrust:{ type:'ion', f:345600,  p:3.36 } },
  { s:[1,1,2], m:121,   thrust:{ type:'ion', f:14400,   p:0.2 } });
B('IonL',      'Large Ion Thruster',           'thrust', 'thruster',
  { s:[3,2,4], m:43200, thrust:{ type:'ion', f:4320000, p:33.6 } },
  { s:[3,2,4], m:721,   thrust:{ type:'ion', f:172800,  p:2.4 } });
B('HydroS',    'Hydrogen Thruster',            'thrust', 'thruster',
  { s:[1,1,1], m:1420,  thrust:{ type:'hydrogen', f:1080000, p:0, h2:803 } },
  { s:[1,1,1], m:334,   thrust:{ type:'hydrogen', f:98400,   p:0, h2:80 } });
B('HydroL',    'Large Hydrogen Thruster',      'thrust', 'thruster',
  { s:[3,3,3], m:6940,  thrust:{ type:'hydrogen', f:7200000, p:0, h2:4820 } },
  { s:[3,3,3], m:1222,  thrust:{ type:'hydrogen', f:480000,  p:0, h2:386 } });
B('AtmoS',     'Atmospheric Thruster',         'thrust', 'thruster',
  { s:[1,1,3], m:4000,  thrust:{ type:'atmo', f:648000,  p:2.4 } },
  { s:[1,1,3], m:699,   thrust:{ type:'atmo', f:96000,   p:0.6 } });
B('AtmoL',     'Large Atmospheric Thruster',   'thrust', 'thruster',
  { s:[3,3,5], m:32970, thrust:{ type:'atmo', f:6480000, p:16.8 } },
  { s:[3,3,5], m:2948,  thrust:{ type:'atmo', f:576000,  p:2.4 } });
B('FlatS',     'Flat Atmospheric Thruster',    'thrust', 'thruster',
  { s:[1,1,1], m:1273,  thrust:{ type:'atmo', f:200000,  p:0.8 } },
  { s:[1,1,1], m:303,   thrust:{ type:'atmo', f:32000,   p:0.2 } });
B('FlatL',     'Large Flat Atmospheric Thruster','thrust','thruster',
  { s:[3,3,2], m:12190, thrust:{ type:'atmo', f:2600000, p:6.7 } },
  { s:[3,3,2], m:1060,  thrust:{ type:'atmo', f:230000,  p:1.0 } });
B('Proto',     'Prototech Thruster',           'thrust', 'thruster',
  { s:[3,3,8], m:38850, thrust:{ type:'prototech', f:14040000, p:67.2 } },
  { s:[3,3,8], m:1521,  thrust:{ type:'prototech', f:561600,   p:4.8 } });

// Power ---------------------------------------------------------------------
B('ReactorS',  'Small Reactor',   'power', 'box', { s:[1,1,1], m:4793, pOut:15, fuelInv:1000 },  { s:[1,1,1], m:278, pOut:0.5, fuelInv:125 });
B('ReactorL',  'Large Reactor',   'power', 'box', { s:[3,3,3], m:72295, pOut:300, fuelInv:8000, approx:1 }, { s:[3,3,3], m:3901, pOut:14.75, fuelInv:1000 });
B('Battery',   'Battery',         'power', 'box', { s:[1,1,1], m:3845, pOut:12, store:3 },     { s:[3,2,3], m:1040.4, pOut:4, store:1 });
B('BatteryS',  'Small Battery',   'power', 'box', null,                                         { s:[1,1,1], m:146.4, pOut:0.2, store:0.05, approx:1 });
B('Solar',     'Solar Panel',     'power', 'solar', { s:[4,2,1], m:516.8, pOut:0.16, solar:1, approx:1 }, { s:[5,10,1], m:143.2, pOut:0.04, solar:1 });
B('H2Engine',  'Hydrogen Engine', 'power', 'box', { s:[1,1,2], m:3253.8, pOut:5 },             { s:[3,2,2], m:1005.2, pOut:0.5 });

// Storage -------------------------------------------------------------------
B('CargoS',    'Small Cargo Container',  'storage', 'box', { s:[1,1,1], m:648.4, inv:15625 },  { s:[1,1,1], m:49.2, inv:125 });
B('CargoM',    'Medium Cargo Container', 'storage', 'box', null,                               { s:[3,3,3], m:274.8, inv:3375 });
B('CargoL',    'Large Cargo Container',  'storage', 'box', { s:[3,3,3], m:2593.6, inv:421875 },{ s:[5,5,5], m:626.2, inv:15625 });
B('CargoBulk', 'Bulk Cargo Containers',  'storage', 'box', { s:[3,3,6], m:5198, inv:820000 },  null);
B('CargoMod',  'Modular Cargo Container (DLC)', 'storage', 'box', null,                        { s:[7,3,5], m:463, inv:10000 });
B('Connector', 'Connector',              'storage', 'box', { s:[1,1,1], m:3564, inv:8000, minor:1 }, { s:[3,3,2], m:685.2, inv:1152, minor:1 });
B('ConnectorS','Small Connector',        'storage', 'box', null,                               { s:[1,1,1], m:204.8, inv:100, minor:1 });
B('H2Tank',    'Hydrogen Tank',          'storage', 'tank', { s:[3,3,3], m:8161.6, h2:15000000 }, { s:[5,5,5], m:1580.8, h2:500000 });
B('H2TankS',   'Small Hydrogen Tank',    'storage', 'tank', { s:[1,2,1], m:3161.6, h2:1000000, approx:1 }, null);
B('O2Tank',    'Oxygen Tank',            'storage', 'tank', { s:[1,2,1], m:3161.6, o2:100000, approx:1 }, { s:[3,3,3], m:450.6, o2:50000, approx:1 });
B('O2H2Gen',   'O2/H2 Generator',        'storage', 'box', { s:[1,2,1], m:2587, invIce:4000, approx:1 }, { s:[3,3,2], m:298.6, invIce:1000, approx:1 });

// Control & comms -------------------------------------------------------------
B('CockpitSG', 'Cockpit',                'control', 'box', null,                         { s:[3,3,3], m:797 });
B('Fighter',   'Fighter Cockpit',        'control', 'box', null,                         { s:[3,4,6], m:1325, approx:1 });
B('CockpitLG', 'Cockpit (large grid)',   'control', 'box', { s:[1,1,1], m:1768, approx:1 }, null);
B('CtrlStation','Control Station',       'control', 'box', { s:[1,1,1], m:518, approx:1 },  null);
B('Remote',    'Remote Control',         'control', 'box', { s:[1,1,1], m:137, approx:1 },  { s:[1,1,1], m:38.2, approx:1 });
B('Gyro',      'Gyroscope',              'control', 'box', { s:[1,1,1], m:12817, approx:1 },{ s:[1,1,1], m:613.6 });
B('ProgBlock', 'Programmable Block',     'control', 'box', { s:[1,1,1], m:534.4, approx:1 },{ s:[1,1,1], m:138.4, approx:1 });
B('Timer',     'Timer Block',            'control', 'box', { s:[1,1,1], m:259, approx:1 },  { s:[1,1,1], m:30.2, approx:1 });
B('Antenna',   'Antenna',                'control', 'box', { s:[1,6,2], m:3481.6, approx:1 },{ s:[1,1,2], m:72.2, approx:1 });
B('Beacon',    'Beacon',                 'control', 'box', { s:[1,2,1], m:3481.6, approx:1 },{ s:[1,1,2], m:52.2, approx:1 });
B('Camera',    'Camera',                 'control', 'box', { s:[1,1,1], m:40.6, approx:1 }, { s:[1,1,1], m:40.6, approx:1 });
B('Sensor',    'Sensor',                 'control', 'box', { s:[1,1,1], m:158.2, approx:1 },{ s:[1,1,1], m:158.2, approx:1 });
B('JumpDrive', 'Jump Drive',             'control', 'box', { s:[3,3,2], m:35980, jump:{ km:2000, massKg:1250000, MWh:3 } }, null);
B('JumpProto', 'Prototech Jump Drive',   'control', 'box', { s:[3,3,3], m:54400, jump:{ km:6000, massKg:2500000, MWh:12 } }, { s:[3,3,4], m:5184, jump:{ km:500, massKg:120000, MWh:2 } });
B('LaserAnt',  'Laser Antenna',          'control', 'box', { s:[1,2,1], m:3584, approx:1 },  { s:[3,3,3], m:666, approx:1 });
B('OreDet',    'Ore Detector',           'control', 'box', { s:[1,1,2], m:1570, approx:1 },  { s:[1,1,2], m:105.2, approx:1 });
B('FlightSeat','Passenger Seat',         'control', 'box', { s:[1,1,1], m:220, approx:1 },   { s:[3,3,3], m:220, approx:1 });
B('LCD',       'LCD Panel',              'control', 'panel', { s:[1,1,1], m:120, approx:1 }, { s:[3,3,1], m:59.8, approx:1 });

// Tools & production ----------------------------------------------------------
B('Drill',     'Drill',                  'tools', 'box', { s:[1,1,3], m:6741, invOre:23437.5 }, { s:[3,3,6], m:1004.2, invOre:3375 });
B('Welder',    'Welder',                 'tools', 'box', { s:[1,1,2], m:713.4, approx:1 },  { s:[3,3,6], m:473.4, approx:1 });
B('Grinder',   'Grinder',                'tools', 'box', { s:[1,1,2], m:761.4, approx:1 },  { s:[3,3,6], m:513.4, approx:1 });
B('Collector', 'Collector',              'tools', 'box', { s:[1,1,1], m:1474, inv:6250, minor:1 }, { s:[3,3,3], m:1237.6, inv:1675, minor:1 });
B('Refinery',  'Refinery',               'tools', 'box', { s:[2,4,2], m:25208, approx:1 },  null);
B('Assembler', 'Assembler',              'tools', 'box', { s:[1,1,2], m:3560, approx:1 },   null);
B('Medical',   'Medical Room',           'tools', 'box', { s:[2,1,2], m:4257, approx:1 },   null);

// Weapons ---------------------------------------------------------------------
B('GatTurret', 'Gatling Turret',         'weapons', 'turret', { s:[3,3,3], m:1428 },           { s:[5,5,5], m:692 });
B('RktTurret', 'Rocket Turret',          'weapons', 'turret', { s:[3,3,3], m:1286, approx:1 }, { s:[5,5,5], m:894 });
B('IntTurret', 'Interior Turret',        'weapons', 'turret', { s:[1,1,1], m:311 },            null);
B('AsltTurret','Assault Cannon Turret',  'weapons', 'turret', { s:[3,2,3], m:9654 },           null);
B('AutoTurret','Autocannon Turret',      'weapons', 'turret', null,                            { s:[5,4,5], m:870 });
B('GatGun',    'Gatling Gun',            'weapons', 'gun',    null,                            { s:[1,1,4], m:140, approx:1 });
B('RktLauncher','Rocket Launcher',       'weapons', 'gun',    { s:[1,1,2], m:1713.8, approx:1 },{ s:[1,1,4], m:226.2, approx:1 });
B('Warhead',   'Warhead',                'weapons', 'box',    { s:[1,1,1], m:500.4, approx:1 }, { s:[1,1,1], m:46.2, approx:1 });
B('Decoy',     'Decoy',                  'weapons', 'box',    { s:[1,1,1], m:126.4, approx:1 }, { s:[1,1,1], m:50.2, approx:1 });

// Mechanical ------------------------------------------------------------------
B('LandingGear','Landing Gear',          'mech', 'gear', { s:[1,2,3], m:3324, approx:1 },   { s:[1,2,3], m:97, approx:1 });
B('Wheel1',    'Wheel Suspension 1x1 (with wheel)','mech','wheel', { s:[2,1,1], m:1382, approx:1 }, { s:[2,1,1], m:353, approx:1 });
B('Wheel3',    'Wheel Suspension 3x3 (with wheel)','mech','wheel', { s:[2,3,3], m:1552, approx:1 }, { s:[2,3,3], m:453, approx:1 });
B('Wheel5',    'Wheel Suspension 5x5 (with wheel)','mech','wheel', { s:[2,5,5], m:3580, approx:1 }, { s:[2,5,5], m:790, approx:1 });
B('Parachute', 'Parachute Hatch',        'mech', 'box', { s:[1,1,1], m:472.4, chute:100000 }, { s:[1,1,1], m:84.2, chute:10000 });
B('ArtMass',   'Artificial Mass',        'mech', 'box', { s:[1,1,1], m:9544, approx:1 },    { s:[1,1,1], m:906.4, approx:1 });
B('Merge',     'Merge Block',            'mech', 'box', { s:[1,1,1], m:473.4, approx:1 },   { s:[1,3,3], m:152.2, approx:1 });
B('Rotor',     'Rotor (base)',           'mech', 'box', { s:[1,2,1], m:576.4, approx:1 },   { s:[1,2,1], m:168.2, approx:1 });
B('Piston',    'Piston (base)',          'mech', 'box', { s:[1,2,1], m:576.4, approx:1 },   { s:[1,2,1], m:176.2, approx:1 });
B('GravGen',   'Gravity Generator',      'mech', 'box', { s:[1,1,1], m:8532, approx:1 },    null);

// Utility & interior ----------------------------------------------------------
// Conveyors -------------------------------------------------------------------
B('ConvJunc',  'Conveyor Junction',      'conveyor', 'box', { s:[1,1,1], m:524, approx:1 },     { s:[1,1,1], m:68, approx:1 });
B('ConvTube',  'Conveyor Tube',          'conveyor', 'box', { s:[1,1,1], m:394, approx:1 },     { s:[1,1,1], m:35, approx:1 });
B('ConvCurve', 'Curved Conveyor Tube',   'conveyor', 'box', { s:[1,1,1], m:394, approx:1 },     { s:[1,1,1], m:35, approx:1 });
B('ConvHubSG', 'Large Conveyor Junction','conveyor', 'box', null,                               { s:[3,3,3], m:783, approx:1 });
B('ConvTubeLSG','Large Conveyor Tube',   'conveyor', 'box', null,                               { s:[3,3,3], m:368, approx:1 });
B('ConvCurveLSG','Large Curved Conveyor Tube','conveyor','box', null,                           { s:[3,3,3], m:365, approx:1 });
B('ConvConverter','Conveyor Converter (large ↔ small)','conveyor','box', null,                  { s:[3,3,1], m:150, approx:1 });
B('Sorter',    'Conveyor Sorter',        'conveyor', 'box', { s:[1,1,1], m:1362, approx:1 },    { s:[1,1,1], m:180, approx:1 });
B('SorterM',   'Conveyor Sorter (large ports)','conveyor','box', null,                          { s:[3,3,1], m:180, approx:1 });
B('Light',     'Interior Light',         'misc', 'box', { s:[1,1,1], m:28, approx:1 },      { s:[1,1,1], m:28, approx:1 });
B('Window',    'Window 1x1',             'misc', 'box', { s:[1,1,1], m:116, approx:1 },     null);
B('Door',      'Door',                   'misc', 'box', { s:[1,1,1], m:582.4, approx:1 },   null);
B('AirVent',   'Air Vent',               'misc', 'box', { s:[1,1,1], m:1871, approx:1 },    { s:[1,1,1], m:253, approx:1 });
B('O2Farm',    'Oxygen Farm',            'misc', 'box', { s:[3,1,1], m:3024, approx:1 },    null);
B('Cryo',      'Cryo Chamber',           'misc', 'box', { s:[1,1,1], m:692, approx:1 },     null);


// ---------------------------------------------------------------------------
// Conveyor ports.  Token: <face><size>[@x.y.z]
//   face: +x -x +y -y +z -z (block-local; -z = front) or * for all six faces
//   size: L = large conveyor port (all items), S = small port (ore, ingots, gas)
//   @x.y.z: local cell the port sits on (default: centre of that face)
// Port layouts are simplified approximations of the in-game models: check the
// real block if a connection matters. Ion/atmospheric thrusters, batteries,
// gyros etc. have no conveyor ports.
// ---------------------------------------------------------------------------
const PORTS = {
  CargoS:      { L: ['*L'], S: ['*S'] },
  CargoM:      { S: ['-zL', '-xL', '+xL', '+yS', '+zS', '-yS'] },
  CargoL:      { L: ['*L'], S: ['-zL', '-xL', '+xL', '+yS', '+zS', '-yS'] },
  CargoBulk:   { L: ['-zL', '+zL', '+xL@2.1.1', '+xL@2.1.4'] },
  CargoMod:    { S: ['-xL', '+xL', '-zL', '+zL'] },
  Connector:   { L: ['+zL'], S: ['+zL'] },
  ConnectorS:  { S: ['+zS'] },
  H2Tank:      { L: ['*L'], S: ['+yL', '-yL', '+xS', '-xS', '+zS', '-zS'] },
  H2TankS:     { L: ['+yL', '-yL'] },
  O2Tank:      { L: ['+yL', '-yL'], S: ['+yL', '-yL'] },
  O2H2Gen:     { L: ['-yL', '+xL@0.0.0', '-xL@0.0.0', '+zL@0.0.0', '-zL@0.0.0'], S: ['+zL', '+xS', '-xS'] },
  HydroS:      { L: ['-zL'], S: ['-zS'] },
  HydroL:      { L: ['-zL'], S: ['-zL'] },
  H2Engine:    { L: ['-zL', '+zL'], S: ['+zL', '+xS', '-xS'] },
  ReactorS:    { L: ['*L'], S: ['*S'] },
  ReactorL:    { L: ['*L'], S: ['*L'] },
  CockpitSG:   { S: ['+zS', '-yS'] },
  Fighter:     { S: ['+zS'] },
  CockpitLG:   { L: ['+zL'] },
  Drill:       { L: ['+zL'], S: ['+zS', '+xS@2.1.5', '-xS@0.1.5'] },
  Welder:      { L: ['+zL'], S: ['+zS'] },
  Grinder:     { L: ['+zL'], S: ['+zS'] },
  Collector:   { L: ['+zL'], S: ['+zL'] },
  Refinery:    { L: ['-xL@0.0.0', '+xL@1.0.1', '-zL@1.0.0', '+zL@0.0.1'] },
  Assembler:   { L: ['-zL', '+zL', '-xL@0.0.0', '+xL@0.0.1'] },
  ConvJunc:    { L: ['*L'], S: ['*S'] },
  GatTurret:   { L: ['-yL'], S: ['-yL'] },
  RktTurret:   { L: ['-yL'], S: ['-yL'] },
  AsltTurret:  { L: ['-yL'] },
  AutoTurret:  { S: ['-yS'] },
  GatGun:      { S: ['+zS'] },
  RktLauncher: { L: ['+zL'], S: ['+zS'] },
  Parachute:   { L: ['-yL'], S: ['-yS'] },
  ConvTube:    { L: ['-zL', '+zL'], S: ['-zS', '+zS'] },
  ConvCurve:   { L: ['-zL', '+yL'], S: ['-zS', '+yS'] },
  ConvHubSG:   { S: ['*L'] },
  ConvTubeLSG: { S: ['-zL', '+zL'] },
  ConvCurveLSG:{ S: ['-zL', '+yL'] },
  ConvConverter:{ S: ['-zL', '+zS'] },
  Sorter:      { L: ['-zL', '+zL'], S: ['-zS', '+zS'] },
  SorterM:     { S: ['-zL', '+zL'] },
};

const FACES = { '+x': [1,0,0], '-x': [-1,0,0], '+y': [0,1,0], '-y': [0,-1,0], '+z': [0,0,1], '-z': [0,0,-1] };
export function faceCentreCell(face, size) {
  const n = FACES[face], c = size.map(v => Math.floor((v - 1) / 2));
  for (let i = 0; i < 3; i++) if (n[i]) c[i] = n[i] > 0 ? size[i] - 1 : 0;
  return c;
}
/** Parse port tokens into [{c:[x,y,z], n:[..], s:'L'|'S'}] for a block of local size `size`. */
export function parsePorts(tokens, size) {
  const out = [];
  for (const t of tokens || []) {
    const m = /^(\*|[+-][xyz])([LS])(?:@(\d+)\.(\d+)\.(\d+))?$/.exec(t);
    if (!m) continue;
    const faces = m[1] === '*' ? Object.keys(FACES) : [m[1]];
    for (const f of faces) {
      const c = m[3] != null ? [+m[3], +m[4], +m[5]] : faceCentreCell(f, size);
      out.push({ c, n: FACES[f], s: m[2] });
    }
  }
  return out;
}

// System roles used by the conveyor checks
const ROLES = {
  CargoS: 'cargo', CargoM: 'cargo', CargoL: 'cargo', CargoBulk: 'cargo', CargoMod: 'cargo',
  Connector: 'connector', ConnectorS: 'connector',
  H2Tank: 'h2tank', H2TankS: 'h2tank', O2Tank: 'o2tank', O2H2Gen: 'gasgen',
  H2Engine: 'h2user', ReactorS: 'reactor', ReactorL: 'reactor',
  CockpitSG: 'cockpit', Fighter: 'cockpit', CockpitLG: 'cockpit',
  Drill: 'drill', Welder: 'welder', Grinder: 'grinder', Collector: 'collector',
  Refinery: 'refinery', Assembler: 'assembler',
  GatTurret: 'weapon', RktTurret: 'weapon', AsltTurret: 'weapon', AutoTurret: 'weapon', GatGun: 'weapon', RktLauncher: 'weapon', Parachute: 'chute',
};

// Flatten into a lookup:  id = `${grid}_${key}`
export const BLOCKS = {};
for (const r of RAW) {
  for (const grid of ['L', 'S']) {
    const spec = r[grid];
    if (!spec) continue;
    const id = `${grid}_${r.key}`;
    BLOCKS[id] = {
      id, key: r.key, grid, name: r.name, cat: r.cat, shape: r.shape, heavy: !!r.heavy,
      size: spec.s, mass: spec.m, approx: !!spec.approx,
      inv: spec.inv || 0, invOre: spec.invOre || 0, invIce: spec.invIce || 0, fuelInv: spec.fuelInv || 0,
      minorInv: !!spec.minor,
      thrust: spec.thrust || null, pOut: spec.pOut || 0, store: spec.store || 0,
      h2: spec.h2 || 0, o2: spec.o2 || 0,
      ports: parsePorts(PORTS[r.key] && PORTS[r.key][grid], spec.s),
      gyro: r.key === 'Gyro' ? (grid === 'L' ? 3.36e7 : 4.48e5) : 0,     // max torque (N·m)
      jump: spec.jump || null, chute: spec.chute || 0, gear: r.key === 'LandingGear' || r.key.startsWith('Wheel'),
      role: ROLES[r.key] || (spec.thrust && spec.thrust.type === 'hydrogen' ? 'h2thrust' : null),
    };
  }
}

// Ship direction names. Ship axes: Forward = -Z, Up = +Y, Right = +X.
export const DIRS = [
  { id: 'up',      name: 'Up',       v: [0, 1, 0] },
  { id: 'down',    name: 'Down',     v: [0,-1, 0] },
  { id: 'forward', name: 'Forward',  v: [0, 0,-1] },
  { id: 'back',    name: 'Backward', v: [0, 0, 1] },
  { id: 'left',    name: 'Left',     v: [-1,0, 0] },
  { id: 'right',   name: 'Right',    v: [1, 0, 0] },
];
