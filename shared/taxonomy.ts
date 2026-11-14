/**
 * Logbook classification taxonomy (owner 2026-11-14, D-42): the tree the Logbooks page filters by, and the table that
 * places every master-data item in it. Five dimensions, every one optional (stop at any level and search):
 *
 *   Kind        Equipment / Instrument / Area
 *   Facility    the dedicated or segregated facility type an item or area belongs to: general, sterile / aseptic,
 *               oncology / cytotoxic (OEB 4–5), beta-lactam (penicillin, cephalosporin, carbapenem), hormones,
 *               immunosuppressants, biologics / vaccines, radiopharmaceuticals, veterinary, nutraceuticals
 *   Form        dosage form or product group, a tree: OSD (Tablet → conventional / modified release / ODT /
 *               effervescent / chewable / multilayer; Capsule → hard gelatin / soft gelatin / liquid-fill; Pellets;
 *               Powders → sachet / dry syrup), Injection (liquid vial and ampoule, lyophilised, dry powder, prefilled
 *               syringe and cartridge, LVP), Biologics and vaccines, Ophthalmic, Inhalation (MDI, DPI, nebules),
 *               Topical (cream, ointment, gel), Transdermal, Suppository, Oral liquid, API (synthetic, highly potent,
 *               fermentation), Radiopharmaceuticals (PET, SPECT), Common and utilities, QC laboratory
 *   Process     a tree, 1 to 3 levels deep where real plants are: Granulation → Wet → High-shear / Fluid bed /
 *               Single pot / Twin screw; Compression → Bilayer → Bilayer / Trilayer / Tablet-in-tablet; Continuous
 *               manufacturing → CDC / feeders / twin screw / coating / PAT; Lyophilisation → Freeze dryer / Loading;
 *               Sterilisation → Terminal → Steam-air mixture / Superheated water; for the QC laboratory the technique
 *               (Chromatography → HPLC / UHPLC / GC / GC-HS / IC; Mass spectrometry → LC-MS/MS / GC-MS / ICP-MS / HRMS …)
 *   Grade       cleanroom grade of an area (A, B, C, D, CNC)
 *
 * PLACEMENT. An item is placed by its master-data TYPE (equipment and instruments: the `type` field, e.g. "Twin screw
 * granulator"; rooms: the `area` field, e.g. "Aseptic filling"). One type may sit in several places (a blender serves
 * tablets and hard capsules; a tray dryer the OSD block and the API block): a type maps to a list of paths. An item
 * placed at a FORM branch belongs to every leaf below it (a dispensing booth under "OSD" shows under Tablet, Capsule …).
 * An item placed at a PROCESS branch shows in that branch and under "Other / unspecified" among its children (a plain
 * "Dryer" is drying, but no particular drying). A type nobody classified goes to "Other" at the kind level. Nothing is
 * ever hidden by the filter.
 *
 * The FACILITY is not a type property: master data has no field for it yet, so it is read from the item's name, else
 * from the name of the room it stands in ("Beta-lactam (cephalosporin) block: …", "Oncology suite", …), else it is the
 * default of its form (sterile forms → sterile / aseptic; biologics → biologics; radiopharmaceuticals → radiopharma;
 * everything else → general). A bench instrument (balance, pH meter, hardness tester …) with a room stands where its
 * room is: form and process of the room, step "IPC". A record WITHOUT a type (the items moved from Batchwright carry
 * none) is typed from its name by NAME_HINTS. These three name rules are stop-gaps until master data carries the
 * classification itself.
 *
 * WHERE THIS BELONGS. By the owner's data-repository rule (platform D-02, D-24) a classification is master data, kept
 * once in Medhanta core and read by every product. Core has no classification fields yet, so the Logbook carries this
 * table until it does (D-42). Nothing here depends on the Logbook: no imports, plain data and pure functions, so the
 * module can move into platform master data (or be replaced by `paths` / `facility` columns of the report views)
 * unchanged. The server (GET /api/equipment adds `type`, `paths`, `facilities`, `grade`) and the web (the cascading
 * filter) both import it.
 *
 * Research basis: WHO TRS 961 and Schedule M (India) process areas for oral solids, sterile products and APIs; ISPE
 * Baseline Guides (OSD, Sterile Product Manufacturing Facilities, Biopharmaceutical, Oral Solid Dosage); EU GMP Annex 1
 * (cleanroom grades, barrier technology), Annex 2 (biologics), Annex 3 (radiopharmaceuticals); ISPE Risk-MaPP and
 * OEB containment bands for highly potent products; the dedicated-facility requirements for beta-lactams, cytotoxics
 * and hormones (EU GMP chapter 3, Schedule M); FDA's continuous manufacturing guidance (ICH Q13); equipment catalogues
 * of Indian and global suppliers; IP/USP general chapters for QC techniques.
 */

export type Kind = 'equipment' | 'instrument' | 'area';
/** [kind, form, process?]; form and process are dotted ids (osd.capsule.hard, granulation.wet.high_shear). */
export type Path = string[];
export const OTHER = 'other';
export const IPC = 'ipc';

export interface Node { id: string; label: string; children?: Node[] }
const n = (id: string, label: string, children?: Node[]): Node => (children ? { id, label, children } : { id, label });

export const KINDS: { id: Kind; label: string }[] = [
  { id: 'equipment', label: 'Equipment' }, { id: 'instrument', label: 'Instruments' }, { id: 'area', label: 'Areas' },
];
export const KIND_LABEL: Record<Kind, string> = { equipment: 'Equipment', instrument: 'Instruments', area: 'Areas' };

export const FACILITIES: Node[] = [
  n('general', 'General (non-dedicated)'),
  n('sterile', 'Sterile / aseptic'),
  n('oncology', 'Oncology / cytotoxic (OEB 4–5)'),
  n('beta_lactam', 'Beta-lactam', [n('beta_lactam.penicillin', 'Penicillin'), n('beta_lactam.cephalosporin', 'Cephalosporin'), n('beta_lactam.carbapenem', 'Carbapenem')]),
  n('hormones', 'Hormones / steroids'),
  n('immunosuppressants', 'Immunosuppressants'),
  n('biologics', 'Biologics / vaccines (BSL-2)'),
  n('radiopharma', 'Radiopharmaceuticals (radiation controlled)'),
  n('veterinary', 'Veterinary'),
  n('nutraceutical', 'Nutraceuticals'),
];

export const FORMS: Node[] = [
  n('osd', 'Oral solid dosage (OSD)', [
    n('osd.tablet', 'Tablet', [
      n('osd.tablet.ir', 'Conventional (immediate release)'), n('osd.tablet.mr', 'Modified release'), n('osd.tablet.odt', 'Orally disintegrating (ODT)'),
      n('osd.tablet.effervescent', 'Effervescent'), n('osd.tablet.chewable', 'Chewable'), n('osd.tablet.multilayer', 'Bilayer / tablet-in-tablet'),
    ]),
    n('osd.capsule', 'Capsule', [n('osd.capsule.hard', 'Hard gelatin'), n('osd.capsule.soft', 'Soft gelatin'), n('osd.capsule.liquid_fill', 'Liquid-fill hard capsule')]),
    n('osd.pellet', 'Pellets / multiparticulates'),
    n('osd.powder', 'Powders and sachets', [n('osd.powder.sachet', 'Sachet / stick pack'), n('osd.powder.dry_syrup', 'Powder for oral suspension (dry syrup)')]),
  ]),
  n('injection', 'Injection', [
    n('injection.svp', 'Liquid vial and ampoule'), n('injection.lyo', 'Lyophilised'), n('injection.dpi', 'Dry powder injection'),
    n('injection.pfs', 'Prefilled syringe and cartridge'), n('injection.lvp', 'Large volume parenteral'),
  ]),
  n('biologics', 'Biologics and vaccines', [n('biologics.mab', 'Recombinant proteins / mAbs'), n('biologics.vaccine', 'Vaccines')]),
  n('ophthalmic', 'Ophthalmic', [n('ophthalmic.drops', 'Eye drops'), n('ophthalmic.ointment', 'Eye ointment (sterile)')]),
  n('inhalation', 'Inhalation', [n('inhalation.mdi', 'Metered dose inhaler (MDI)'), n('inhalation.dpi', 'Dry powder inhaler (DPI)'), n('inhalation.nebule', 'Nebules')]),
  n('spray_drop', 'Sprays and drops', [
    n('spray_drop.nasal', 'Nasal', [n('spray_drop.nasal.spray', 'Nasal spray (metered pump)'), n('spray_drop.nasal.drops', 'Nasal drops')]),
    n('spray_drop.ear', 'Ear drops'),
    n('spray_drop.eye', 'Eye drops (sterile)', [n('spray_drop.eye.solution', 'Solution'), n('spray_drop.eye.suspension', 'Suspension'), n('spray_drop.eye.pf_multidose', 'Multi-dose preservative-free'), n('spray_drop.eye.unit_dose', 'Unit-dose BFS')]),
    n('spray_drop.oral', 'Oral sprays and drops', [n('spray_drop.oral.spray', 'Oral spray'), n('spray_drop.oral.drops', 'Oral drops')]),
    n('spray_drop.topical_spray', 'Topical spray', [n('spray_drop.topical_spray.pump', 'Pump spray'), n('spray_drop.topical_spray.aerosol', 'Aerosol')]),
  ]),
  n('topical', 'Topical / semi-solid', [
    n('topical.cream', 'Cream', [n('topical.cream.ow', 'Oil-in-water'), n('topical.cream.wo', 'Water-in-oil')]), n('topical.ointment', 'Ointment'),
    n('topical.gel', 'Gel', [n('topical.gel.hydrogel', 'Hydrogel'), n('topical.gel.emulgel', 'Emulgel')]), n('topical.paste', 'Paste'), n('topical.lotion', 'Lotion'),
    n('topical.foam', 'Foam'), n('topical.shampoo', 'Medicated shampoo'), n('topical.steroid', 'Dermatological steroid (segregated)'), n('topical.antiinfective', 'Antifungal / antibiotic'),
  ]),
  n('transdermal', 'Transdermal patch'),
  n('suppository', 'Suppository / pessary'),
  n('liquid', 'Liquids (oral and external)', [
    n('liquid.solution', 'Oral solution'), n('liquid.syrup', 'Syrup', [n('liquid.syrup.sugar', 'Sugar-based'), n('liquid.syrup.sugar_free', 'Sugar-free')]), n('liquid.suspension', 'Suspension'),
    n('liquid.emulsion', 'Emulsion'), n('liquid.dry_syrup', 'Dry syrup / powder for reconstitution'), n('liquid.elixir', 'Elixir / linctus'),
    n('liquid.mouthwash', 'Mouthwash / gargle'), n('liquid.topical', 'Topical solution / antiseptic'),
    n('liquid.lvo', 'Large-volume oral liquid (antacid)'),
  ]),
  n('api', 'API (bulk drug)', [
    n('api.synthetic', 'Synthetic small molecule'), n('api.hpapi', 'Highly potent / oncology API'), n('api.peptide', 'Peptide (SPPS)'), n('api.oligo', 'Oligonucleotide'),
    n('api.fermentation', 'Fermentation / biocatalysis'), n('api.steroid', 'Steroid / hormone API'), n('api.beta_lactam', 'Beta-lactam API and intermediates'), n('api.sterile', 'Sterile API'),
    n('api.extraction', 'Vitamins / APIs by extraction'),
  ]),
  n('radiopharma', 'Radiopharmaceuticals', [n('radiopharma.pet', 'PET (F-18, Ga-68)'), n('radiopharma.spect', 'SPECT (Tc-99m kits)')]),
  n('common', 'Common and utilities'),
  n('qc', 'QC laboratory'),
];

/** Processes and QC techniques, one tree with ids unique across forms; the display order of the rows. */
export const PROCESSES: Node[] = [
  // Oral solids and general manufacturing
  n('dispensing', 'Dispensing', [n('dispensing.booth', 'Dispensing booth / RLAF'), n('dispensing.weighing', 'Weighing'), n('dispensing.sampling', 'Sampling'), n('dispensing.containment', 'Containment (isolator, closed transfer)')]),
  n('sifting', 'Sifting', [n('sifting.vibro', 'Vibro sifter'), n('sifting.mechanical', 'Mechanical sifter')]),
  n('granulation', 'Granulation', [
    n('granulation.wet', 'Wet granulation', [n('granulation.wet.high_shear', 'High-shear (RMG)'), n('granulation.wet.fluid_bed', 'Fluid bed (top spray)'), n('granulation.wet.single_pot', 'Single pot processor'), n('granulation.wet.twin_screw', 'Twin screw (continuous)'), n('granulation.wet.planetary', 'Planetary / mass mixer')]),
    n('granulation.dry', 'Dry granulation', [n('granulation.dry.roller_compaction', 'Roller compaction'), n('granulation.dry.slugging', 'Slugging')]),
    n('granulation.melt', 'Melt granulation', [n('granulation.melt.hot_melt_extrusion', 'Hot-melt extrusion'), n('granulation.melt.melt_pelletisation', 'Melt pelletisation')]),
    n('granulation.spray_drying', 'Spray drying'),
  ]),
  n('drying', 'Drying', [n('drying.fbd', 'Fluid bed'), n('drying.tray', 'Tray'), n('drying.vacuum_tray', 'Vacuum tray'), n('drying.rcvd', 'Rotary cone vacuum'), n('drying.microwave_vacuum', 'Microwave / vacuum single pot'), n('drying.spray', 'Spray dryer'), n('drying.paddle', 'Paddle / agitated dryer'), n('drying.freeze', 'Freeze drying (API)'), n('drying.tumble', 'Tumble (softgel)'), n('drying.tunnel', 'Drying tunnel (softgel)')]),
  n('milling', 'Milling and sizing', [n('milling.multimill', 'Multimill'), n('milling.comill', 'Co-mill (conical)'), n('milling.oscillating', 'Oscillating granulator'), n('milling.pin_mill', 'Pin mill'),
    n('milling.micronisation', 'Micronisation', [n('milling.micronisation.jet_mill', 'Jet mill'), n('milling.micronisation.nano_mill', 'Nano mill (wet media)'), n('milling.micronisation.cryogenic', 'Cryogenic mill')])]),
  n('blending', 'Blending', [n('blending.octagonal', 'Octagonal'), n('blending.bin', 'IPC bin'), n('blending.v', 'V blender'), n('blending.double_cone', 'Double cone'), n('blending.ribbon', 'Ribbon'), n('blending.continuous', 'Continuous blender')]),
  n('compression', 'Compression', [n('compression.rotary', 'Rotary press'), n('compression.double_rotary', 'Double rotary press'),
    n('compression.multilayer', 'Multilayer', [n('compression.multilayer.bilayer', 'Bilayer'), n('compression.multilayer.trilayer', 'Trilayer'), n('compression.multilayer.tablet_in_tablet', 'Tablet-in-tablet')]),
    n('compression.single_punch', 'Single punch'), n('compression.closed_loop', 'Closed-loop weight control'),
    n('compression.dedusting', 'Dedusting and metal detection', [n('compression.dedusting.deduster', 'Deduster'), n('compression.dedusting.metal_detector', 'Metal detector')])]),
  n('continuous', 'Continuous manufacturing', [n('continuous.cdc', 'Continuous direct compression'), n('continuous.feeders', 'Loss-in-weight feeders'), n('continuous.twin_screw', 'Continuous wet granulation'), n('continuous.coating', 'Continuous coating'), n('continuous.pat', 'PAT (in-line NIR / Raman)')]),
  n('coating', 'Coating', [n('coating.film', 'Film'), n('coating.sugar', 'Sugar'), n('coating.enteric', 'Enteric / functional'), n('coating.wurster', 'Wurster / rotor (pellets)'), n('coating.continuous', 'Continuous'), n('coating.solution_prep', 'Solution preparation')]),
  n('pelletisation', 'Pelletisation', [n('pelletisation.extrusion', 'Extrusion'), n('pelletisation.spheronisation', 'Spheronisation'), n('pelletisation.layering', 'Drug layering (rotor)')]),
  n('capsule_filling', 'Capsule filling', [n('capsule_filling.auto', 'Automatic'), n('capsule_filling.semi_auto', 'Semi-automatic'), n('capsule_filling.liquid_fill', 'Liquid fill and banding'), n('capsule_filling.checkweigh', 'Checkweighing'), n('capsule_filling.polishing', 'Polishing and sorting'), n('capsule_filling.banding', 'Banding and sealing')]),
  n('gelatin', 'Gelatin and fill preparation', [n('gelatin.melting', 'Gelatin melting'), n('gelatin.fill_prep', 'Fill preparation')]),
  n('encapsulation', 'Softgel encapsulation', [n('encapsulation.rotary_die', 'Rotary die'), n('encapsulation.inspection', 'Inspection and polishing')]),
  n('sachet_filling', 'Sachet and powder filling', [n('sachet_filling.sachet', 'Sachet'), n('sachet_filling.stick_pack', 'Stick pack'), n('sachet_filling.dry_syrup', 'Dry syrup bottle filling')]),
  n('inspection', 'Inspection', [n('inspection.fill_level', 'Fill level'), n('inspection.fill_weight', 'Fill weight checkweigher'), n('inspection.seal', 'Seal integrity'), n('inspection.coding', 'Tube coding / printing'), n('inspection.water_bath', 'Water bath leak test'), n('inspection.visual', 'Manual visual'), n('inspection.auto', 'Automatic', [n('inspection.auto.vision', 'Vision inspection'), n('inspection.auto.avi', 'Automated visual inspection (injectables)')]), n('inspection.leak', 'Leak / CCIT'), n('inspection.printing', 'Printing')]),
  n('packing', 'Packing', [n('packing.blister', 'Blister', [n('packing.blister.thermoform', 'Thermoform'), n('packing.blister.coldform', 'Cold-form (alu-alu)')]), n('packing.strip', 'Strip'), n('packing.tube', 'Tube / stick'),
    n('packing.bottle', 'Bottle', [n('packing.bottle.counting', 'Counting and filling'), n('packing.bottle.induction_sealing', 'Induction sealing'), n('packing.bottle.capping', 'Capping')]),
    n('packing.labelling', 'Labelling'), n('packing.cartoning', 'Cartoning'), n('packing.checkweigh', 'Check weighing'), n('packing.serialisation', 'Serialisation and aggregation'), n('packing.secondary', 'Secondary and shipper'), n('packing.leak', 'Leak test')]),
  // Sterile
  n('washing', 'Washing', [n('washing.vial', 'Vial'), n('washing.ampoule', 'Ampoule'), n('washing.ultrasonic', 'Ultrasonic (components)'), n('washing.bottle', 'Bottle')]),
  n('depyrogenation', 'Depyrogenation', [n('depyrogenation.tunnel', 'Tunnel'), n('depyrogenation.dhs', 'Dry heat steriliser')]),
  n('components', 'Component preparation', [n('components.stopper_washing', 'Stopper washing / siliconising'), n('components.nest_tub', 'Nest and tub (debagging, e-beam)'), n('components.transfer', 'Transfer (pass box, mobile LAF)'), n('components.garments', 'Garments')]),
  n('syrup_prep', 'Sugar syrup preparation', [n('syrup_prep.dissolving', 'Sugar dissolving / melting vessel'), n('syrup_prep.syrup_filter', 'Syrup filter press')]),
  n('compounding', 'Compounding / manufacturing', [n('compounding.vessel', 'Manufacturing vessel'), n('compounding.jacketed', 'Jacketed vessel'), n('compounding.syrup_vessel', 'Sugar syrup vessel'), n('compounding.storage', 'Holding / storage tank'), n('compounding.single_use', 'Single-use mixer'),
    n('compounding.homogeniser', 'Homogeniser'), n('compounding.inline_shear', 'In-line high shear mixer'), n('compounding.emulsification', 'Emulsification (vacuum homogeniser)'), n('compounding.colloid_mill', 'Colloid mill'), n('compounding.stirrer', 'Stirrer'),
    n('compounding.additive', 'Preservative / colour / flavour addition'), n('compounding.ph', 'pH adjustment'), n('compounding.deaeration', 'Deaeration')]),
  n('transfer', 'Transfer and storage', [n('transfer.pump', 'Transfer pump', [n('transfer.pump.lobe', 'Lobe pump'), n('transfer.pump.peristaltic', 'Peristaltic pump')]), n('transfer.lines', 'Transfer lines'), n('transfer.storage_tank', 'Storage tank'), n('transfer.holding_tank', 'Jacketed holding tank')]),
  n('filtration', 'Filtration', [n('filtration.sterile', 'Sterilising filtration'), n('filtration.integrity', 'Filter integrity'), n('filtration.filter_press', 'Filter press'), n('filtration.sparkler', 'Sparkler / plate filter'), n('filtration.cartridge', 'Cartridge filter'), n('filtration.bag', 'Bag filter'), n('filtration.clarifying', 'Clarifying')]),
  n('filling', 'Filling (aseptic / fill-finish)', [n('filling.vial', 'Vial'), n('filling.ampoule', 'Ampoule fill and seal'), n('filling.powder', 'Powder (dry powder injection)'), n('filling.syringe', 'Nested syringe'), n('filling.cartridge', 'Cartridge'),
    n('filling.lvp', 'LVP bag / bottle'), n('filling.bfs', 'Blow-fill-seal'), n('filling.bottle', 'Bottle (liquids, ophthalmics)', [n('filling.bottle.volumetric', 'Volumetric / piston filler'), n('filling.bottle.gravity', 'Gravity / peristaltic filler')]),
    n('filling.unscrambler', 'Bottle unscrambler'), n('filling.bottle_washing', 'Bottle washing / air jet cleaning'), n('filling.capping', 'Capping (liquids)', [n('filling.capping.ropp', 'ROPP'), n('filling.capping.crc', 'Child-resistant (CRC)')]),
    n('filling.induction_sealing', 'Induction sealing'), n('filling.cup_placer', 'Measuring cup placer'), n('filling.dropper', 'Dropper bottle (LDPE plug insertion)'), n('filling.nasal_pump', 'Nasal / oral spray pump crimping / screw'),
    n('filling.aseptic_eye', 'Aseptic eye drop filling (isolator / RABS)'),
    n('filling.aerosol', 'Aerosol filling', [n('filling.aerosol.pressure_fill', 'Pressure fill'), n('filling.aerosol.cold_fill', 'Cold fill'), n('filling.aerosol.valve_crimping', 'Valve crimping'), n('filling.aerosol.propellant', 'Propellant filling (ATEX)')]),
    n('filling.barrier', 'Barrier systems', [n('filling.barrier.isolator', 'Isolator'), n('filling.barrier.rabs', 'RABS'), n('filling.barrier.laf', 'Laminar air flow')])]),
  n('stoppering', 'Stoppering', [n('stoppering.stoppering', 'Stoppering'), n('stoppering.plunger', 'Plunger placement')]),
  n('lyophilisation', 'Lyophilisation', [n('lyophilisation.freeze_dryer', 'Freeze dryer'), n('lyophilisation.loading', 'Automatic loading / unloading'), n('lyophilisation.cip', 'Lyo CIP / SIP')]),
  n('capping', 'Capping and sealing', [n('capping.capping', 'Vial capping'), n('capping.crimping', 'Crimping')]),
  n('sterilisation', 'Sterilisation and decontamination', [n('sterilisation.steam', 'Steam (autoclave)'), n('sterilisation.terminal', 'Terminal', [n('sterilisation.terminal.sam', 'Steam-air mixture'), n('sterilisation.terminal.shw', 'Superheated water')]),
    n('sterilisation.dry_heat', 'Dry heat'), n('sterilisation.sip', 'CIP / SIP skid'), n('sterilisation.vhp', 'VHP decontamination'), n('sterilisation.ebeam', 'E-beam')]),
  n('cip', 'CIP (tanks and lines)'),
  n('gowning', 'Gowning, airlocks and washing', [n('gowning.change_room', 'Change room'), n('gowning.airlock', 'Airlock'), n('gowning.corridor', 'Corridor'), n('gowning.decon', 'Washing bay / decontamination')]),
  // Biologics
  n('upstream', 'Upstream', [n('upstream.media_prep', 'Media preparation'), n('upstream.seed', 'Seed / inoculum'), n('upstream.bioreactor', 'Bioreactor', [n('upstream.bioreactor.stainless', 'Stainless steel'), n('upstream.bioreactor.single_use', 'Single-use')]), n('upstream.harvest', 'Harvest / clarification')]),
  n('downstream', 'Downstream', [n('downstream.buffer_prep', 'Buffer preparation'), n('downstream.chromatography', 'Chromatography skid'), n('downstream.uf_df', 'TFF / UF-DF'), n('downstream.viral', 'Viral clearance', [n('downstream.viral.inactivation', 'Inactivation'), n('downstream.viral.filtration', 'Virus filtration')])]),
  // Semi-solids, transdermal, suppositories, inhalation
  n('phase_prep', 'Water and oil phase preparation', [n('phase_prep.oil_phase', 'Oil phase melting vessel'), n('phase_prep.water_phase', 'Water phase vessel'), n('phase_prep.wax_melting', 'Wax melting')]),
  n('semisolid', 'Semi-solid manufacturing', [n('semisolid.emulsifier', 'Vacuum emulsifying mixer'), n('semisolid.planetary', 'Planetary mixer'), n('semisolid.anchor', 'Contra-rotating anchor stirrer'), n('semisolid.homogeniser', 'In-line / bottom homogeniser'),
    n('semisolid.ointment_mill', 'Triple roller / ointment mill'), n('semisolid.deaeration', 'Deaeration under vacuum'), n('semisolid.cooling', 'Cooling jacket')]),
  n('gel_prep', 'Gel preparation', [n('gel_prep.polymer_dispersion', 'Polymer dispersion'), n('gel_prep.neutralisation', 'Neutralisation')]),
  n('api_dispersion', 'API dispersion', [n('api_dispersion.premix', 'Pre-mix'), n('api_dispersion.wetting', 'Wetting')]),
  n('tube_filling', 'Tube, jar and sachet filling', [n('tube_filling.tube', 'Tube (generic)'), n('tube_filling.lami', 'Laminate tube'), n('tube_filling.alu', 'Aluminium tube'),
    n('tube_filling.sealing', 'Tube sealing', [n('tube_filling.sealing.hot_air', 'Hot air'), n('tube_filling.sealing.ultrasonic', 'Ultrasonic'), n('tube_filling.sealing.crimp', 'Crimp / fold')]),
    n('tube_filling.jar', 'Jar'), n('tube_filling.sachet', 'Sachet'), n('tube_filling.airless', 'Airless pump bottle'), n('tube_filling.aseptic', 'Aseptic ophthalmic ointment tube')]),
  n('spray_testing', 'Spray and dose testing', [n('spray_testing.actuation', 'Pump actuation / priming'), n('spray_testing.plume', 'Spray pattern / plume geometry'), n('spray_testing.droplet', 'Droplet size (laser diffraction)'), n('spray_testing.dose', 'Shot weight / delivered dose'), n('spray_testing.force', 'Actuation force'), n('spray_testing.leak', 'Leak test')]),
  n('lamination', 'Coating and lamination', [n('lamination.coating', 'Coating'), n('lamination.die_cutting', 'Die cutting'), n('lamination.pouching', 'Pouching')]),
  n('moulding', 'Moulding (suppositories)', [n('moulding.filling', 'Form, fill and seal'), n('moulding.cooling', 'Cooling')]),
  n('inhaler_filling', 'Inhaler filling', [n('inhaler_filling.mdi', 'MDI filling and crimping'), n('inhaler_filling.dpi', 'DPI capsule / blister'), n('inhaler_filling.device_assembly', 'Device assembly')]),
  // API
  n('reaction', 'Reaction', [
    n('reaction.batch', 'Batch reactors', [n('reaction.batch.ss_reactor', 'Stainless steel'), n('reaction.batch.gl_reactor', 'Glass-lined'), n('reaction.batch.hastelloy', 'Hastelloy'), n('reaction.batch.cryogenic', 'Cryogenic'), n('reaction.batch.high_pressure', 'High pressure / hydrogenation'), n('reaction.batch.grignard', 'Grignard')]),
    n('reaction.flow', 'Continuous / flow chemistry', [n('reaction.flow.plug_flow', 'Plug-flow reactor'), n('reaction.flow.microreactor', 'Microreactor')]),
    n('reaction.spps', 'Solid-phase peptide synthesis'), n('reaction.oligo', 'Oligonucleotide synthesis'),
    n('reaction.fermentation', 'Fermentation / biocatalysis', [n('reaction.fermentation.fermenter', 'Fermenter'), n('reaction.fermentation.biocatalysis', 'Biocatalysis reactor')]),
    n('reaction.charging', 'Charging'), n('reaction.atex', 'ATEX solvent handling')]),
  n('workup', 'Work-up', [n('workup.extraction', 'Extraction'), n('workup.phase_separation', 'Phase separation'), n('workup.distillation', 'Distillation', [n('workup.distillation.batch', 'Batch distillation'), n('workup.distillation.short_path', 'Short-path / wiped-film')])]),
  n('purification', 'Purification', [n('purification.crystallisation', 'Crystallisation', [n('purification.crystallisation.cooling', 'Cooling'), n('purification.crystallisation.anti_solvent', 'Anti-solvent'), n('purification.crystallisation.chiral', 'Chiral resolution')]),
    n('purification.prep_chromatography', 'Preparative chromatography', [n('purification.prep_chromatography.smb', 'Simulated moving bed')]), n('purification.carbon', 'Carbon treatment')]),
  n('isolation', 'Isolation', [n('isolation.centrifuge', 'Centrifuge', [n('isolation.centrifuge.peeler', 'Peeler'), n('isolation.centrifuge.pusher', 'Pusher')]), n('isolation.anfd', 'Agitated nutsche filter dryer'), n('isolation.nutsche', 'Nutsche filter'), n('isolation.filter_press', 'Filter press')]),
  n('sterile_api', 'Sterile API', [n('sterile_api.sterile_filtration', 'Sterile filtration'), n('sterile_api.aseptic_crystallisation', 'Aseptic crystallisation'), n('sterile_api.sterile_drying', 'Sterile drying'), n('sterile_api.sterile_packing', 'Sterile packing')]),
  n('solvent_recovery', 'Solvent recovery', [n('solvent_recovery.distillation', 'Distillation'), n('solvent_recovery.storage', 'Solvent tank farm')]),
  n('effluent', 'Effluent and emissions', [n('effluent.scrubber', 'Scrubber'), n('effluent.etp', 'Effluent treatment plant')]),
  // Radiopharmaceuticals
  n('cyclotron', 'Cyclotron'), n('radiosynthesis', 'Radiosynthesis module'), n('hot_cell', 'Hot cell'), n('shielded_dispensing', 'Shielded dispensing'), n('decay_storage', 'Decay storage'),
  // Common and utilities
  n('hvac', 'HVAC', [n('hvac.ahu', 'Air handling unit'), n('hvac.dehumidifier', 'Dehumidifier'), n('hvac.exhaust', 'Exhaust and dust extraction'), n('hvac.bms', 'Building management system'), n('hvac.monitoring', 'Monitoring')]),
  n('water', 'Water systems', [n('water.pw', 'Purified water', [n('water.pw.ro_edi', 'RO-EDI')]), n('water.wfi', 'Water for injection', [n('water.wfi.mcd', 'Multi-column distillation'), n('water.wfi.vc', 'Vapour compression')]), n('water.distribution', 'Distribution loop')]),
  n('steam', 'Steam', [n('steam.boiler', 'Boiler'), n('steam.pure_steam', 'Pure steam generator')]),
  n('gases', 'Compressed air, gases and vacuum', [n('gases.compressed_air', 'Compressed air'), n('gases.nitrogen', 'Nitrogen'), n('gases.vacuum', 'Vacuum system')]),
  n('cooling', 'Cooling and heating media', [n('cooling.chiller', 'Chiller'), n('cooling.cooling_tower', 'Cooling tower'), n('cooling.brine', 'Brine plant'), n('cooling.hot_oil', 'Hot oil / thermic fluid')]),
  n('power', 'Power', [n('power.dg', 'Diesel generator'), n('power.ups', 'UPS')]),
  n('warehouse', 'Warehouse', [n('warehouse.storage', 'Storage'), n('warehouse.sampling', 'Sampling booth'), n('warehouse.cold_room', 'Cold room'), n('warehouse.quarantine', 'Quarantine')]),
  n('engineering', 'Engineering', [n('engineering.workshop', 'Workshop'), n('engineering.calibration', 'Calibration laboratory')]),
  // QC laboratory, by technique
  n('chromatography', 'Chromatography', [n('chromatography.hplc', 'HPLC'), n('chromatography.uhplc', 'UHPLC'), n('chromatography.prep_hplc', 'Preparative HPLC'), n('chromatography.gc', 'GC'), n('chromatography.gc_hs', 'GC headspace'), n('chromatography.ic', 'Ion chromatography'), n('chromatography.chiral_hplc', 'Chiral HPLC'), n('chromatography.tlc', 'TLC')]),
  n('mass_spec', 'Mass spectrometry', [n('mass_spec.lcms', 'LC-MS/MS'), n('mass_spec.gcms', 'GC-MS'), n('mass_spec.icpms', 'ICP-MS'), n('mass_spec.hrms', 'HRMS / Q-TOF')]),
  n('spectroscopy', 'Spectroscopy', [n('spectroscopy.uv', 'UV-visible'), n('spectroscopy.ir', 'FTIR / ATR'), n('spectroscopy.nir', 'NIR'), n('spectroscopy.raman', 'Raman'), n('spectroscopy.aas', 'AAS'), n('spectroscopy.icp_oes', 'ICP-OES'), n('spectroscopy.fluorescence', 'Fluorescence'), n('spectroscopy.nmr', 'NMR'),
    n('spectroscopy.optical', 'Optical', [n('spectroscopy.optical.polarimeter', 'Polarimeter'), n('spectroscopy.optical.refractometer', 'Refractometer')])]),
  n('solid_state', 'Particle and solid state', [n('solid_state.psd', 'Laser diffraction PSD'), n('solid_state.xrpd', 'XRPD'), n('solid_state.dsc', 'DSC'), n('solid_state.tga', 'TGA'), n('solid_state.dvs', 'DVS'), n('solid_state.bet', 'BET surface area'), n('solid_state.globule', 'Globule / droplet size'), n('solid_state.microscopy', 'Polarised light microscopy'), n('solid_state.sieve', 'Sieve analysis')]),
  n('dissolution', 'Dissolution and disintegration', [n('dissolution.usp1_2', 'USP I / II'), n('dissolution.usp3', 'USP III reciprocating cylinder'), n('dissolution.usp4', 'USP IV flow-through'), n('dissolution.autosampler', 'Auto-sampling'), n('dissolution.ivrt', 'IVRT (Franz diffusion cell)'), n('dissolution.disintegration', 'Disintegration')]),
  n('physical', 'Physical tests', [n('physical.hardness', 'Hardness'), n('physical.friability', 'Friability'), n('physical.thickness', 'Thickness'), n('physical.density', 'Bulk and tapped density'), n('physical.density_meter', 'Density meter'), n('physical.melting', 'Melting point'),
    n('physical.viscosity', 'Viscosity', [n('physical.viscosity.viscometer', 'Viscometer (Brookfield, spindles)'), n('physical.viscosity.rheometer', 'Rheometer')]), n('physical.osmolality', 'Osmolality'),
    n('physical.texture', 'Texture analyser'), n('physical.spreadability', 'Spreadability'), n('physical.centrifuge_stability', 'Centrifuge stability (emulsions)')]),
  n('titration', 'Titration', [n('titration.kf', 'Karl Fischer', [n('titration.kf.volumetric', 'Volumetric'), n('titration.kf.coulometric', 'Coulometric')]), n('titration.autotitrator', 'Potentiometric')]),
  n('weighing', 'Weighing', [n('weighing.micro', 'Micro balance'), n('weighing.semi_micro', 'Semi-micro balance'), n('weighing.analytical', 'Analytical balance'), n('weighing.precision', 'Precision balance'), n('weighing.platform', 'Platform balance')]),
  n('ph', 'pH and conductivity', [n('ph.ph', 'pH'), n('ph.conductivity', 'Conductivity')]),
  n('moisture', 'Moisture', [n('moisture.lod', 'Loss on drying (IR / halogen)'), n('moisture.oven', 'Oven LOD')]),
  n('water_testing', 'Water testing', [n('water_testing.toc', 'TOC'), n('water_testing.conductivity', 'Conductivity')]),
  n('particulates', 'Particulate matter', [n('particulates.light_obscuration', 'Light obscuration'), n('particulates.mfi', 'Micro-flow imaging (sub-visible)')]),
  n('ccit', 'Container closure integrity', [n('ccit.headspace_o2', 'Headspace O2 / laser'), n('ccit.hvld', 'HVLD'), n('ccit.vacuum_decay', 'Vacuum decay')]),
  n('microbiology', 'Microbiology', [n('microbiology.sterilisation', 'Autoclave'), n('microbiology.incubation', 'Incubation'), n('microbiology.laf', 'LAF / biosafety cabinet'), n('microbiology.sterility_isolator', 'Sterility test isolator'), n('microbiology.counting', 'Colony counting'),
    n('microbiology.air_sampling', 'Air sampling'), n('microbiology.particle_counting', 'Particle counting'), n('microbiology.endotoxin', 'Endotoxin', [n('microbiology.endotoxin.lal', 'LAL reader'), n('microbiology.endotoxin.rfc', 'rFC reader')]),
    n('microbiology.rapid', 'Rapid micro methods'), n('microbiology.mlt', 'Microbial limit test (membrane filtration)'), n('microbiology.identification', 'Identification'), n('microbiology.microscope', 'Microscope')]),
  n('stability', 'Stability', [n('stability.chamber', 'Stability chamber'), n('stability.walk_in', 'Walk-in chamber'), n('stability.photostability', 'Photostability')]),
  n('environmental', 'Environmental monitoring and mapping', [n('environmental.data_logger', 'Data logger'), n('environmental.mapping', 'Temperature mapping'), n('environmental.dp_gauge', 'Differential pressure'), n('environmental.thermohygrometer', 'Thermohygrometer')]),
  n('radio_qc', 'Radiopharmaceutical QC', [n('radio_qc.dose_calibrator', 'Dose calibrator'), n('radio_qc.radio_tlc', 'Radio-TLC'), n('radio_qc.radio_hplc', 'Radio-HPLC detector'), n('radio_qc.gamma_spectrometer', 'Gamma spectrometer'), n('radio_qc.contamination_monitor', 'Contamination monitor')]),
  n('general', 'General laboratory', [n('general.oven', 'Hot air oven'), n('general.water_bath', 'Water bath'), n('general.centrifuge', 'Centrifuge'), n('general.sonicator', 'Sonicator'), n('general.fume_hood', 'Fume hood'), n('general.furnace', 'Muffle furnace'), n('general.refrigerator', 'Refrigerator / freezer')]),
];

/** Which top-level processes each form family has ("show all categories" lists them even when empty). */
export const FAMILY_PROCESSES: Record<string, string[]> = {
  osd: ['dispensing', 'water', 'sifting', 'granulation', 'drying', 'milling', 'blending', 'compression', 'continuous', 'coating', 'pelletisation', 'capsule_filling', 'gelatin', 'encapsulation', 'sachet_filling', 'inspection', 'packing', 'gowning'],
  injection: ['dispensing', 'milling', 'washing', 'depyrogenation', 'components', 'compounding', 'filtration', 'filling', 'stoppering', 'lyophilisation', 'capping', 'sterilisation', 'inspection', 'packing', 'gowning'],
  biologics: ['upstream', 'downstream', 'washing', 'depyrogenation', 'components', 'compounding', 'filtration', 'filling', 'stoppering', 'lyophilisation', 'capping', 'sterilisation', 'inspection', 'packing', 'gowning'],
  ophthalmic: ['dispensing', 'components', 'compounding', 'filtration', 'filling', 'phase_prep', 'semisolid', 'tube_filling', 'spray_testing', 'sterilisation', 'inspection', 'packing', 'gowning'],
  inhalation: ['dispensing', 'milling', 'drying', 'blending', 'compounding', 'filling', 'inhaler_filling', 'spray_testing', 'inspection', 'packing', 'gowning'],
  topical: ['dispensing', 'water', 'phase_prep', 'semisolid', 'gel_prep', 'api_dispersion', 'transfer', 'tube_filling', 'filling', 'inspection', 'packing', 'cip', 'sterilisation', 'gowning'],
  spray_drop: ['dispensing', 'compounding', 'filtration', 'filling', 'spray_testing', 'inspection', 'packing', 'sterilisation', 'gowning'],
  transdermal: ['dispensing', 'compounding', 'lamination', 'packing', 'gowning'],
  suppository: ['dispensing', 'phase_prep', 'semisolid', 'moulding', 'packing', 'gowning'],
  liquid: ['dispensing', 'water', 'syrup_prep', 'compounding', 'transfer', 'filtration', 'filling', 'sachet_filling', 'inspection', 'packing', 'cip', 'gowning'],
  api: ['dispensing', 'reaction', 'workup', 'purification', 'isolation', 'drying', 'milling', 'blending', 'sterile_api', 'solvent_recovery', 'effluent', 'packing', 'gowning'],
  radiopharma: ['cyclotron', 'radiosynthesis', 'hot_cell', 'shielded_dispensing', 'components', 'filtration', 'filling', 'radio_qc', 'decay_storage', 'gowning'],
  common: ['hvac', 'water', 'steam', 'gases', 'cooling', 'power', 'warehouse', 'engineering', 'cip', 'gowning'],
  qc: ['chromatography', 'mass_spec', 'spectroscopy', 'solid_state', 'dissolution', 'physical', 'titration', 'weighing', 'ph', 'moisture', 'water_testing', 'particulates', 'ccit', 'microbiology', 'stability', 'environmental', 'radio_qc', 'spray_testing', 'general', 'gowning'],
};

/*
 * TYPE → PATHS. A spec is "form[,form…] [process]": dotted form ids ("*" = every form family), then one dotted process.
 * Keys match case-insensitively and trimmed. For rooms the key is the `area` value.
 */
type Specs = string[];
const OSD_GRAN = 'osd.tablet,osd.capsule.hard,osd.pellet';
export const EQUIPMENT_TYPES: Record<string, Specs> = {
  // Dispensing and containment
  'Dispensing booth': ['osd dispensing.booth'], 'Reverse laminar air flow': ['osd,liquid,api dispensing.booth'], 'Sampling booth': ['common warehouse.sampling'],
  'Containment isolator': ['osd,api dispensing.containment'], 'Closed transfer system': ['osd,api dispensing.containment'],
  // Sifting, granulation, drying, milling, blending
  'Sifter': ['osd sifting.vibro'], 'Vibro sifter': ['osd sifting.vibro'], 'Mechanical sifter': ['osd sifting.mechanical'],
  'Granulator': [`${OSD_GRAN} granulation.wet.high_shear`], 'Rapid mixer granulator': [`${OSD_GRAN} granulation.wet.high_shear`], 'High shear mixer granulator': [`${OSD_GRAN} granulation.wet.high_shear`],
  'Planetary mixer': ['osd.tablet,osd.capsule.hard granulation.wet.planetary'], 'Mass mixer': ['osd.tablet,osd.capsule.hard granulation.wet.planetary'],
  'Single pot processor': ['osd.tablet granulation.wet.single_pot', 'osd.tablet drying.microwave_vacuum'],
  'Twin screw granulator': ['osd.tablet granulation.wet.twin_screw', 'osd.tablet continuous.twin_screw'],
  'Fluid bed processor': [`${OSD_GRAN} granulation.wet.fluid_bed`, `${OSD_GRAN} drying.fbd`], 'Wurster coater': ['osd.pellet coating.wurster'], 'Rotor processor': ['osd.pellet pelletisation.layering'],
  'Roller compactor': ['osd.tablet,osd.capsule.hard granulation.dry.roller_compaction'], 'Slugging press': ['osd.tablet granulation.dry.slugging'],
  'Hot melt extruder': ['osd.tablet,osd.capsule.hard granulation.melt.hot_melt_extrusion'], 'Melt granulator': ['osd.tablet,osd.capsule.hard granulation.melt'], 'Melt pelletiser': ['osd.pellet granulation.melt.melt_pelletisation'],
  'Spray dryer': ['osd granulation.spray_drying', 'api drying.spray', 'inhalation.dpi drying.spray'],
  'Dryer': ['osd.tablet,osd.capsule.hard drying'], 'Fluid bed dryer': [`${OSD_GRAN} drying.fbd`], 'Tray dryer': ['osd.tablet,osd.capsule.hard drying.tray', 'api drying.tray'],
  'Vacuum tray dryer': ['api drying.vacuum_tray', 'osd.tablet drying.vacuum_tray'], 'Rotary cone vacuum dryer': ['api drying.rcvd'], 'Microwave vacuum dryer': ['osd.tablet drying.microwave_vacuum'],
  'Tumble dryer': ['osd.capsule.soft drying.tumble'], 'Drying tunnel': ['osd.capsule.soft drying.tunnel'],
  'Mill': ['osd.tablet,osd.capsule.hard milling'], 'Multimill': ['osd.tablet,osd.capsule.hard milling.multimill', 'api milling.multimill'], 'Co-mill': ['osd.tablet,osd.capsule.hard milling.comill'],
  'Oscillating granulator': ['osd.tablet,osd.capsule.hard milling.oscillating'], 'Jet mill': ['api,inhalation.dpi milling.micronisation.jet_mill'], 'Nano mill': ['api,injection.svp milling.micronisation.nano_mill'],
  'Cryogenic mill': ['api milling.micronisation.cryogenic'],
  'Blender': ['osd.tablet,osd.capsule.hard blending'], 'Octagonal blender': ['osd.tablet,osd.capsule.hard blending.octagonal', 'api blending.octagonal'], 'Bin blender': ['osd.tablet,osd.capsule.hard,inhalation.dpi blending.bin'],
  'V blender': ['osd.tablet,osd.capsule.hard blending.v'], 'Double cone blender': ['osd.tablet,osd.capsule.hard blending.double_cone', 'api blending.double_cone'], 'Ribbon blender': ['osd,osd.powder blending.ribbon'],
  'Continuous blender': ['osd.tablet blending.continuous', 'osd.tablet continuous.cdc'],
  // Compression, continuous, coating, pellets
  'Tablet press': ['osd.tablet compression.rotary'], 'Double rotary tablet press': ['osd.tablet compression.double_rotary'], 'High speed tablet press': ['osd.tablet compression.closed_loop'],
  'Bilayer tablet press': ['osd.tablet.multilayer compression.multilayer.bilayer'], 'Trilayer tablet press': ['osd.tablet.multilayer compression.multilayer.trilayer'],
  'Tablet-in-tablet press': ['osd.tablet.multilayer compression.multilayer.tablet_in_tablet'], 'Single punch tablet press': ['osd.tablet compression.single_punch'],
  'Effervescent tablet press': ['osd.tablet.effervescent compression.rotary'], 'Deduster': ['osd.tablet compression.dedusting.deduster'], 'Metal detector': ['osd.tablet compression.dedusting.metal_detector'],
  'Continuous direct compression line': ['osd.tablet continuous.cdc'], 'Loss-in-weight feeder': ['osd.tablet continuous.feeders'], 'Continuous coater': ['osd.tablet coating.continuous', 'osd.tablet continuous.coating'],
  'Coater': ['osd.tablet coating.film'], 'Auto coater': ['osd.tablet coating.film'], 'Sugar coating pan': ['osd.tablet coating.sugar'], 'Enteric coater': ['osd.tablet.mr coating.enteric'],
  'Vessel': ['osd.tablet coating.solution_prep', 'liquid compounding.vessel'], 'Coating solution vessel': ['osd.tablet coating.solution_prep'],
  'Extruder': ['osd.pellet pelletisation.extrusion'], 'Spheroniser': ['osd.pellet pelletisation.spheronisation'],
  'Tablet inspection belt': ['osd.tablet inspection.visual'], 'Automated tablet inspection machine': ['osd.tablet inspection.auto.vision'], 'Tablet printer': ['osd.tablet inspection.printing'],
  // Capsules, softgels, sachets
  'Capsule filling machine': ['osd.capsule.hard capsule_filling.auto'], 'Semi-automatic capsule filler': ['osd.capsule.hard capsule_filling.semi_auto'],
  'Capsule filler with checkweigher': ['osd.capsule.hard capsule_filling.auto', 'osd.capsule.hard capsule_filling.checkweigh'], 'Liquid capsule filling and banding machine': ['osd.capsule.liquid_fill capsule_filling.liquid_fill'],
  'Capsule polisher': ['osd.capsule.hard capsule_filling.polishing'], 'Capsule sorter': ['osd.capsule.hard capsule_filling.polishing'], 'Capsule bander': ['osd.capsule.hard,osd.capsule.liquid_fill capsule_filling.banding'],
  'Empty capsule loader': ['osd.capsule.hard capsule_filling.auto'], 'DPI capsule filling machine': ['inhalation.dpi inhaler_filling.dpi'],
  'Gelatin melter': ['osd.capsule.soft gelatin.melting'], 'Gelatin reactor': ['osd.capsule.soft gelatin.melting'], 'Fill preparation tank': ['osd.capsule.soft gelatin.fill_prep'],
  'Softgel encapsulation machine': ['osd.capsule.soft encapsulation.rotary_die'], 'Softgel inspection machine': ['osd.capsule.soft encapsulation.inspection'],
  'Sachet filling machine': ['osd.powder.sachet sachet_filling.sachet'], 'Stick pack machine': ['osd.powder.sachet sachet_filling.stick_pack'], 'Dry syrup powder filling machine': ['osd.powder.dry_syrup,liquid.dry_syrup sachet_filling.dry_syrup'],
  // Packing
  'Blister packer': ['osd packing.blister.thermoform'], 'High speed blister line': ['osd packing.blister.thermoform', 'osd packing.serialisation'], 'Cold form blister machine': ['osd packing.blister.coldform'],
  'Strip packer': ['osd packing.strip'], 'Effervescent tube filler': ['osd.tablet.effervescent packing.tube'], 'Tablet counter': ['osd packing.bottle.counting'], 'Bottle filling line': ['osd packing.bottle.counting', 'osd packing.bottle.capping'],
  'Induction sealer': ['osd packing.bottle.induction_sealing', 'liquid filling.induction_sealing'], 'Cartoner': ['osd,injection,liquid,topical packing.cartoning'], 'Check weigher': ['osd,liquid,injection packing.checkweigh'],
  'Labeller': ['osd,liquid packing.labelling'], 'Serialisation and aggregation system': ['osd,injection,liquid packing.serialisation'], 'Bundling machine': ['osd,liquid packing.secondary'],
  'Shrink wrapper': ['osd,injection packing.secondary'], 'Case packer': ['osd,injection packing.secondary'],
  // Sterile: washing to packing
  'Vial washing machine': ['injection,biologics washing.vial'], 'Ampoule washing machine': ['injection.svp washing.ampoule'], 'Ultrasonic washer': ['injection washing.ultrasonic'],
  'Depyrogenation tunnel': ['injection,biologics depyrogenation.tunnel'], 'Dry heat steriliser': ['injection depyrogenation.dhs', 'injection sterilisation.dry_heat'],
  'Stopper processor': ['injection components.stopper_washing'], 'Nest and tub debagger': ['injection.pfs components.nest_tub'], 'E-beam tunnel': ['injection.pfs components.nest_tub', 'injection.pfs sterilisation.ebeam'],
  'Pass box': ['injection,biologics,radiopharma,ophthalmic components.transfer'], 'Mobile laminar air flow': ['injection components.transfer'], 'Garment cabinet': ['injection,biologics components.garments'],
  'Compounding vessel': ['injection,ophthalmic,spray_drop compounding.vessel'], 'Mobile vessel': ['injection compounding.storage'], 'Magnetic stirrer': ['injection compounding.stirrer'],
  'Single-use mixer': ['biologics,injection compounding.single_use'],
  'Sterile filtration skid': ['injection,biologics,ophthalmic,spray_drop.eye,radiopharma filtration.sterile'], 'Filter housing': ['injection filtration.sterile'],
  'Vial filling machine': ['injection.svp,injection.lyo filling.vial'], 'Fill-finish line': ['biologics,injection filling.vial'], 'Powder filling machine': ['injection.dpi filling.powder'],
  'Ampoule filling and sealing machine': ['injection.svp filling.ampoule'], 'Syringe filling machine': ['injection.pfs filling.syringe'], 'Cartridge filling machine': ['injection.pfs filling.cartridge'],
  'Blow-fill-seal machine': ['injection.lvp,ophthalmic.drops,spray_drop.eye.unit_dose,inhalation.nebule filling.bfs'], 'LVP bag filling machine': ['injection.lvp filling.lvp'],
  'Isolator': ['injection,biologics filling.barrier.isolator'], 'RABS': ['injection,biologics filling.barrier.rabs'], 'Laminar air flow': ['injection,biologics filling.barrier.laf'],
  'Stoppering machine': ['injection stoppering.stoppering'], 'Plunger placement unit': ['injection.pfs stoppering.plunger'],
  'Lyophiliser': ['injection.lyo,biologics lyophilisation.freeze_dryer'], 'Freeze dryer': ['injection.lyo,biologics lyophilisation.freeze_dryer'], 'Lyophiliser loading system': ['injection.lyo,biologics lyophilisation.loading'],
  'Capping machine': ['injection,biologics capping.capping', 'liquid filling.capping'], 'Vial crimper': ['injection capping.crimping'],
  'Autoclave': ['injection,biologics,ophthalmic sterilisation.steam'], 'Steam steriliser': ['injection sterilisation.steam'], 'Terminal steriliser': ['injection.svp,injection.lvp sterilisation.terminal'],
  'Steam-air mixture steriliser': ['injection.svp,injection.lvp sterilisation.terminal.sam'], 'Superheated water steriliser': ['injection.lvp sterilisation.terminal.shw'],
  'CIP SIP station': ['injection,biologics sterilisation.sip'], 'VHP generator': ['injection,biologics sterilisation.vhp'],
  'Visual inspection machine': ['injection,biologics inspection.auto.avi'], 'Inspection booth': ['injection,biologics inspection.visual'], 'Vial leak tester': ['injection inspection.leak'],
  'Vial labelling machine': ['injection,biologics packing.labelling'], 'Tray loader': ['injection packing.secondary'],
  // Biologics
  'Bioreactor': ['biologics upstream.bioreactor.stainless'], 'Single-use bioreactor': ['biologics upstream.bioreactor.single_use'], 'Incubator shaker': ['biologics upstream.seed'],
  'Media preparation vessel': ['biologics upstream.media_prep'], 'Cell harvest centrifuge': ['biologics upstream.harvest'], 'Depth filtration skid': ['biologics upstream.harvest'],
  'Chromatography skid': ['biologics downstream.chromatography'], 'TFF system': ['biologics downstream.uf_df'], 'Buffer preparation vessel': ['biologics downstream.buffer_prep'],
  'Viral inactivation vessel': ['biologics downstream.viral.inactivation'], 'Virus filtration skid': ['biologics downstream.viral.filtration'],
  // Oral liquids
  'Manufacturing vessel': ['liquid compounding.vessel'], 'Jacketed manufacturing vessel': ['liquid compounding.jacketed'], 'Sugar syrup vessel': ['liquid.syrup.sugar compounding.syrup_vessel'],
  'Sugar dissolving vessel': ['liquid.syrup.sugar syrup_prep.dissolving'], 'Syrup filter press': ['liquid.syrup.sugar syrup_prep.syrup_filter'], 'Storage tank': ['liquid transfer.storage_tank'],
  'Homogeniser': ['liquid.suspension,spray_drop compounding.homogeniser', 'osd.capsule.soft gelatin.fill_prep', 'topical semisolid.homogeniser'], 'In-line high shear mixer': ['liquid compounding.inline_shear'],
  'Vacuum homogeniser': ['liquid.emulsion compounding.emulsification', 'topical semisolid.emulsifier'], 'Colloid mill': ['liquid.suspension compounding.colloid_mill', 'osd.capsule.soft gelatin.fill_prep'],
  'Stirrer': ['liquid compounding.stirrer'], 'Additive dosing vessel': ['liquid compounding.additive'], 'Deaerator': ['liquid compounding.deaeration'],
  'Lobe pump': ['liquid transfer.pump.lobe'], 'Peristaltic pump': ['liquid transfer.pump.peristaltic'], 'Transfer line': ['liquid transfer.lines'],
  'Filter press': ['liquid filtration.filter_press', 'api isolation.filter_press'], 'Sparkler filter': ['liquid filtration.sparkler'], 'Cartridge filter': ['liquid filtration.cartridge'], 'Bag filter': ['liquid filtration.bag'],
  'Bottle unscrambler': ['liquid filling.unscrambler'], 'Bottle washing machine': ['liquid filling.bottle_washing'], 'Air jet cleaning machine': ['liquid filling.bottle_washing'],
  'Liquid filling machine': ['liquid filling.bottle'], 'Volumetric liquid filler': ['liquid filling.bottle.volumetric'], 'Peristaltic liquid filler': ['liquid,spray_drop filling.bottle.gravity'],
  'Liquid filling line': ['liquid filling.bottle', 'liquid filling.capping'], 'ROPP capping machine': ['liquid filling.capping.ropp'], 'CRC capping machine': ['liquid filling.capping.crc'],
  'Dropper insertion machine': ['spray_drop.oral.drops,spray_drop.ear filling.dropper'], 'Measuring cup placer': ['liquid filling.cup_placer'],
  'Fill level inspection system': ['liquid inspection.fill_level'], 'Sticker labeller': ['liquid,osd packing.labelling'], 'CIP skid': ['liquid,topical,common cip'],
  'Antacid manufacturing vessel': ['liquid.lvo compounding.jacketed'], 'Mouthwash manufacturing vessel': ['liquid.mouthwash compounding.vessel'], 'Lotion filling machine': ['liquid.topical filling.bottle.volumetric'],
  // Semi-solids, ophthalmics, transdermal, suppositories, inhalation
  'Oil phase vessel': ['topical,ophthalmic.ointment phase_prep.oil_phase'], 'Water phase vessel': ['topical phase_prep.water_phase'], 'Wax melting vessel': ['topical phase_prep.wax_melting'], 'Melting vessel': ['topical,suppository phase_prep.oil_phase'],
  'Vacuum emulsifier': ['topical,ophthalmic.ointment semisolid.emulsifier'], 'Planetary mixer (semi-solid)': ['topical semisolid.planetary'], 'Anchor stirrer vessel': ['topical semisolid.anchor'],
  'Bottom homogeniser': ['topical semisolid.homogeniser'], 'Ointment mill': ['topical,ophthalmic.ointment semisolid.ointment_mill'], 'Vacuum deaerator': ['topical semisolid.deaeration'],
  'Polymer dispersion unit': ['topical.gel gel_prep.polymer_dispersion'], 'Neutralisation vessel': ['topical.gel gel_prep.neutralisation'], 'Pre-mix vessel': ['topical api_dispersion.premix'], 'Wetting vessel': ['topical api_dispersion.wetting'],
  'Jacketed holding tank': ['topical,liquid transfer.holding_tank'],
  'Tube filling machine': ['topical tube_filling.tube'], 'Laminate tube filler': ['topical tube_filling.lami', 'topical tube_filling.sealing.hot_air'], 'Aluminium tube filler': ['topical tube_filling.alu', 'topical tube_filling.sealing.crimp'],
  'Ultrasonic tube sealer': ['topical tube_filling.sealing.ultrasonic'], 'Jar filling machine': ['topical tube_filling.jar'], 'Semi-solid sachet filler': ['topical tube_filling.sachet'], 'Airless pump bottle filler': ['topical tube_filling.airless'],
  'Aseptic ointment tube filler': ['ophthalmic.ointment tube_filling.aseptic'], 'Tube coding printer': ['topical inspection.coding'], 'Seal integrity tester': ['topical inspection.seal'], 'Fill weight checkweigher': ['topical,spray_drop inspection.fill_weight'],
  'Foam filling machine': ['topical.foam filling.aerosol.pressure_fill'], 'Shampoo filling machine': ['topical.shampoo filling.bottle.volumetric'],
  'Ophthalmic bottle filling machine': ['ophthalmic.drops,spray_drop.eye filling.aseptic_eye'], 'Eye drop filling machine': ['ophthalmic.drops,spray_drop.eye filling.aseptic_eye'],
  'Nasal spray pump crimping machine': ['spray_drop.nasal.spray filling.nasal_pump'], 'Oral spray filling machine': ['spray_drop.oral.spray filling.nasal_pump'],
  'Dropper bottle filling machine': ['spray_drop.nasal.drops,spray_drop.ear,spray_drop.oral.drops filling.dropper'], 'Spray compounding vessel': ['spray_drop compounding.vessel'],
  'Aerosol filling machine': ['spray_drop.topical_spray.aerosol,inhalation.mdi filling.aerosol.pressure_fill'], 'Cold fill aerosol machine': ['spray_drop.topical_spray.aerosol,inhalation.mdi filling.aerosol.cold_fill'],
  'Aerosol valve crimper': ['spray_drop.topical_spray.aerosol,inhalation.mdi filling.aerosol.valve_crimping'], 'Propellant filling station': ['spray_drop.topical_spray.aerosol,inhalation.mdi filling.aerosol.propellant'],
  'Water bath leak tester': ['spray_drop.topical_spray.aerosol,inhalation.mdi inspection.water_bath'], 'Pump spray filling machine': ['spray_drop.topical_spray.pump filling.nasal_pump'],
  'Spray actuation station': ['spray_drop,inhalation spray_testing.actuation'],
  'Adhesive mixing vessel': ['transdermal compounding.vessel'], 'Coating and lamination machine': ['transdermal lamination.coating'], 'Die cutting machine': ['transdermal lamination.die_cutting'], 'Pouching machine': ['transdermal lamination.pouching'],
  'Suppository filling machine': ['suppository moulding.filling'], 'Suppository cooling tunnel': ['suppository moulding.cooling'],
  'MDI filling and crimping machine': ['inhalation.mdi inhaler_filling.mdi'], 'Inhaler device assembly machine': ['inhalation inhaler_filling.device_assembly'],
  // API
  'Reactor': ['api reaction.batch.ss_reactor'], 'Glass lined reactor': ['api reaction.batch.gl_reactor'], 'Hastelloy reactor': ['api reaction.batch.hastelloy'], 'Cryogenic reactor': ['api reaction.batch.cryogenic'],
  'Hydrogenator': ['api reaction.batch.high_pressure'], 'Grignard reactor': ['api reaction.batch.grignard'], 'Flow reactor': ['api reaction.flow.plug_flow'], 'Microreactor': ['api reaction.flow.microreactor'],
  'Peptide synthesiser': ['api.peptide reaction.spps'], 'Oligonucleotide synthesiser': ['api.oligo reaction.oligo'], 'Fermenter': ['api.fermentation reaction.fermentation.fermenter'], 'Biocatalysis reactor': ['api.fermentation reaction.fermentation.biocatalysis'],
  'Powder charging system': ['api reaction.charging'], 'ATEX solvent handling system': ['api reaction.atex'],
  'Liquid-liquid extractor': ['api workup.extraction', 'api.extraction workup.extraction'], 'Phase separator': ['api workup.phase_separation'], 'Batch distillation unit': ['api workup.distillation.batch'],
  'Short path distillation unit': ['api workup.distillation.short_path'], 'Wiped film evaporator': ['api workup.distillation.short_path', 'api.extraction workup.distillation.short_path'],
  'Crystalliser': ['api purification.crystallisation.cooling'], 'Anti-solvent crystalliser': ['api purification.crystallisation.anti_solvent'], 'Chiral resolution vessel': ['api purification.crystallisation.chiral'],
  'Preparative chromatography system': ['api purification.prep_chromatography', 'api.peptide purification.prep_chromatography'], 'SMB chromatography system': ['api purification.prep_chromatography.smb'], 'Carbon treatment vessel': ['api purification.carbon'],
  'Centrifuge': ['api isolation.centrifuge'], 'Peeler centrifuge': ['api isolation.centrifuge.peeler'], 'Pusher centrifuge': ['api isolation.centrifuge.pusher'], 'Nutsche filter': ['api isolation.nutsche'],
  'Agitated nutsche filter dryer': ['api isolation.anfd', 'api drying.vacuum_tray'], 'Paddle dryer': ['api drying.paddle'], 'Conical dryer': ['api drying.rcvd'], 'API freeze dryer': ['api.sterile drying.freeze'],
  'Pin mill': ['api milling.pin_mill'], 'Sterile API filtration skid': ['api.sterile sterile_api.sterile_filtration'], 'Sterile crystalliser': ['api.sterile sterile_api.aseptic_crystallisation'],
  'Sterile API dryer': ['api.sterile sterile_api.sterile_drying'], 'Sterile API packing isolator': ['api.sterile sterile_api.sterile_packing'],
  'Distillation column': ['api solvent_recovery.distillation'], 'Solvent storage tank': ['api solvent_recovery.storage'], 'Scrubber': ['api effluent.scrubber'], 'Effluent treatment plant': ['api effluent.etp'],
  'Drum packing station': ['api packing.secondary'],
  // Radiopharmaceuticals
  'Cyclotron': ['radiopharma.pet cyclotron'], 'Radiosynthesis module': ['radiopharma.pet radiosynthesis'], 'Hot cell': ['radiopharma hot_cell'],
  'Shielded dispensing isolator': ['radiopharma shielded_dispensing'], 'Tc-99m generator shield': ['radiopharma.spect shielded_dispensing'], 'Decay storage cabinet': ['radiopharma decay_storage'],
  // Common and utilities
  'AHU': ['common hvac.ahu'], 'Dehumidifier': ['common hvac.dehumidifier'], 'Dust extractor': ['common hvac.exhaust'], 'Building management system': ['common hvac.bms'],
  'Water system': ['common water.pw'], 'Purified water system': ['common water.pw'], 'RO-EDI purified water system': ['common water.pw.ro_edi'], 'WFI generator': ['common water.wfi.mcd'],
  'Vapour compression distiller': ['common water.wfi.vc'], 'Water distribution loop': ['common water.distribution'],
  'Boiler': ['common steam.boiler'], 'Pure steam generator': ['common steam.pure_steam'], 'Compressor': ['common gases.compressed_air'], 'Nitrogen generator': ['common gases.nitrogen'],
  'Chiller': ['common cooling.chiller'], 'Cooling tower': ['common cooling.cooling_tower'], 'Brine plant': ['common cooling.brine'], 'Hot oil system': ['common cooling.hot_oil'], 'Vacuum pump system': ['common gases.vacuum'], 'DG set': ['common power.dg'], 'UPS': ['common power.ups'],
  'Cold room': ['common warehouse.cold_room'], 'Pallet racking': ['common warehouse.storage'],
  // QC laboratory equipment
  'Stability chamber': ['qc stability.chamber'], 'Walk-in stability chamber': ['qc stability.walk_in'], 'Photostability chamber': ['qc stability.photostability'],
  'Incubator': ['qc microbiology.incubation'], 'Laboratory autoclave': ['qc microbiology.sterilisation'], 'Biosafety cabinet': ['qc microbiology.laf'], 'Sterility test isolator': ['qc microbiology.sterility_isolator'],
  'Hot air oven': ['qc general.oven'], 'Water bath': ['qc general.water_bath'], 'Laboratory centrifuge': ['qc general.centrifuge'], 'Sonicator': ['qc general.sonicator'], 'Fume hood': ['qc general.fume_hood'],
  'Muffle furnace': ['qc general.furnace'], 'Laboratory refrigerator': ['qc general.refrigerator'], 'Deep freezer': ['qc general.refrigerator'],
};

export const INSTRUMENT_TYPES: Record<string, Specs> = {
  // Chromatography and mass spectrometry
  'HPLC': ['qc chromatography.hplc'], 'UPLC': ['qc chromatography.uhplc'], 'UHPLC': ['qc chromatography.uhplc'], 'Preparative HPLC': ['qc chromatography.prep_hplc'],
  'Chiral HPLC': ['qc chromatography.chiral_hplc'], 'GC': ['qc chromatography.gc'], 'GC headspace': ['qc chromatography.gc_hs'], 'Ion chromatograph': ['qc chromatography.ic'], 'TLC scanner': ['qc chromatography.tlc'],
  'LC-MS/MS': ['qc mass_spec.lcms'], 'GC-MS': ['qc mass_spec.gcms'], 'ICP-MS': ['qc mass_spec.icpms'], 'Q-TOF mass spectrometer': ['qc mass_spec.hrms'],
  // Spectroscopy
  'Spectrophotometer': ['qc spectroscopy.uv'], 'UV-visible spectrophotometer': ['qc spectroscopy.uv'], 'FTIR': ['qc spectroscopy.ir'], 'NIR analyser': ['qc spectroscopy.nir', 'osd.tablet continuous.pat'],
  'Raman spectrometer': ['qc spectroscopy.raman', 'osd.tablet continuous.pat'], 'AAS': ['qc spectroscopy.aas'], 'ICP-OES': ['qc spectroscopy.icp_oes'], 'Fluorescence spectrometer': ['qc spectroscopy.fluorescence'],
  'NMR spectrometer': ['qc spectroscopy.nmr'], 'Polarimeter': ['qc spectroscopy.optical.polarimeter'], 'Refractometer': ['qc spectroscopy.optical.refractometer'],
  // Particle and solid state
  'Particle size analyser': ['qc solid_state.psd'], 'XRPD': ['qc solid_state.xrpd'], 'DSC': ['qc solid_state.dsc'], 'TGA': ['qc solid_state.tga'], 'DVS': ['qc solid_state.dvs'],
  'BET surface area analyser': ['qc solid_state.bet'], 'Polarised light microscope': ['qc solid_state.microscopy'], 'Sieve shaker': ['qc solid_state.sieve'],
  // Dissolution and physical
  'Dissolution apparatus': ['qc dissolution.usp1_2'], 'Reciprocating cylinder dissolution': ['qc dissolution.usp3'], 'Flow-through dissolution': ['qc dissolution.usp4'],
  'Dissolution autosampler': ['qc dissolution.autosampler'], 'Disintegration tester': ['qc dissolution.disintegration'],
  'Hardness tester': ['qc physical.hardness'], 'Friabilator': ['qc physical.friability'], 'Thickness gauge': ['qc physical.thickness'], 'Tap density tester': ['qc physical.density'],
  'Density meter': ['qc physical.density_meter'], 'Melting point apparatus': ['qc physical.melting'], 'Viscometer': ['qc physical.viscosity.viscometer'], 'Rheometer': ['qc physical.viscosity.rheometer'], 'Brookfield viscometer': ['qc physical.viscosity.viscometer'], 'Texture analyser': ['qc physical.texture'], 'Spreadability tester': ['qc physical.spreadability'],
  'Stability centrifuge': ['qc physical.centrifuge_stability'], 'Globule size analyser': ['qc solid_state.globule'], 'Franz diffusion cell': ['qc dissolution.ivrt'],
  'Spray pattern analyser': ['qc spray_testing.plume'], 'Droplet size analyser': ['qc spray_testing.droplet'], 'Shot weight tester': ['qc spray_testing.dose'], 'Actuation force tester': ['qc spray_testing.force'], 'Aerosol leak tester': ['qc spray_testing.leak'], 'Osmometer': ['qc physical.osmolality'],
  // Titration, weighing, pH, moisture, water
  'Titrator': ['qc titration.autotitrator'], 'Karl Fischer titrator': ['qc titration.kf.volumetric'], 'Coulometric KF titrator': ['qc titration.kf.coulometric'],
  'Balance': ['qc weighing.analytical'], 'Analytical balance': ['qc weighing.analytical'], 'Semi-micro balance': ['qc weighing.semi_micro'], 'Micro balance': ['qc weighing.micro'],
  'Precision balance': ['qc weighing.precision'], 'Platform balance': ['osd,liquid,api dispensing.weighing'], 'IPC balance': ['osd.tablet compression.ipc', 'osd.capsule.hard capsule_filling.ipc'],
  'pH meter': ['qc ph.ph'], 'Conductivity meter': ['qc ph.conductivity'], 'Moisture analyser': ['qc moisture.lod'], 'TOC analyser': ['qc water_testing.toc'],
  // Particulates and CCIT
  'Liquid particle counter': ['qc particulates.light_obscuration'], 'Micro-flow imaging system': ['qc particulates.mfi'],
  'Headspace oxygen analyser': ['qc ccit.headspace_o2', 'injection inspection.leak'], 'HVLD leak tester': ['qc ccit.hvld', 'injection inspection.leak'], 'Vacuum decay leak tester': ['qc ccit.vacuum_decay', 'injection inspection.leak'],
  // Microbiology
  'Colony counter': ['qc microbiology.counting'], 'Air sampler': ['qc microbiology.air_sampling'], 'Particle counter': ['qc microbiology.particle_counting'],
  'Endotoxin reader': ['qc microbiology.endotoxin.lal'], 'rFC endotoxin reader': ['qc microbiology.endotoxin.rfc'], 'Rapid microbial method system': ['qc microbiology.rapid'], 'Membrane filtration unit': ['qc microbiology.mlt'], 'Preservative efficacy incubator': ['qc microbiology.incubation'],
  'Microbial identification system': ['qc microbiology.identification'], 'Microscope': ['qc microbiology.microscope'],
  // Environmental
  'Data logger': ['qc environmental.data_logger'], 'Temperature mapping kit': ['qc environmental.mapping'], 'Differential pressure gauge': ['qc environmental.dp_gauge'],
  'Thermohygrometer': ['qc environmental.thermohygrometer'], 'Anemometer': ['common hvac.monitoring'], 'Tachometer': ['common engineering.calibration'],
  // Radiopharmaceutical QC
  'Dose calibrator': ['radiopharma radio_qc.dose_calibrator', 'qc radio_qc.dose_calibrator'], 'Radio-TLC scanner': ['radiopharma radio_qc.radio_tlc', 'qc radio_qc.radio_tlc'],
  'Radio-HPLC detector': ['radiopharma radio_qc.radio_hplc', 'qc radio_qc.radio_hplc'], 'Gamma spectrometer': ['radiopharma radio_qc.gamma_spectrometer', 'qc radio_qc.gamma_spectrometer'],
  'Contamination monitor': ['radiopharma radio_qc.contamination_monitor'],
  // Shop floor and in-process
  'Filter integrity tester': ['injection,biologics,ophthalmic,spray_drop.eye filtration.integrity'], 'Leak tester': ['osd,liquid packing.leak'], 'Torque tester': ['osd,liquid packing.bottle.capping'],
  'Metal detector': ['osd.tablet compression.dedusting.metal_detector'], 'Checkweigher': ['osd,liquid packing.checkweigh'], 'Vision inspection system': ['osd,injection inspection.auto.vision'],
  'NIR probe': ['osd.tablet continuous.pat'], 'Tablet tester': ['qc physical.hardness', 'qc physical.thickness'],
};

/** Generic bench instruments go where they stand: a balance in a compression room is IPC of compression; in QC it is weighing. */
export const LOCATED_INSTRUMENTS = new Set(['balance', 'analytical balance', 'semi-micro balance', 'micro balance', 'precision balance', 'platform balance', 'ph meter', 'conductivity meter',
  'ipc balance', 'density meter', 'refractometer', 'viscometer', 'moisture analyser', 'hardness tester', 'friabilator', 'disintegration tester', 'thickness gauge', 'tablet tester', 'thermohygrometer', 'particle counter', 'data logger', 'differential pressure gauge']);

/** Rooms: the `area` value → path. */
export const AREA_TYPES: Record<string, Specs> = {
  'Dispensing': ['osd dispensing'], 'Sterile dispensing': ['injection dispensing'], 'Liquid dispensing': ['liquid dispensing'], 'Containment dispensing': ['osd,api dispensing.containment'],
  'Sifting': ['osd sifting'], 'Granulation': ['osd.tablet,osd.capsule.hard granulation'], 'Drying': ['osd.tablet,osd.capsule.hard drying'], 'Milling': ['osd.tablet,osd.capsule.hard milling'],
  'Blending': ['osd.tablet,osd.capsule.hard blending'], 'Compression': ['osd.tablet compression'], 'Continuous manufacturing': ['osd.tablet continuous'], 'Coating': ['osd.tablet coating'],
  'Pelletisation': ['osd.pellet pelletisation'], 'Capsule filling': ['osd.capsule.hard capsule_filling'], 'Gelatin preparation': ['osd.capsule.soft gelatin'], 'Softgel encapsulation': ['osd.capsule.soft encapsulation'],
  'Softgel drying': ['osd.capsule.soft drying'], 'Sachet filling': ['osd.powder sachet_filling'], 'Inspection': ['osd inspection'], 'Packing': ['osd packing'], 'Primary packing': ['osd packing'], 'Secondary packing': ['osd packing.secondary'],
  'Vial washing': ['injection washing'], 'Depyrogenation': ['injection depyrogenation'], 'Component preparation': ['injection components'], 'Sterile compounding': ['injection compounding'],
  'Sterile filtration': ['injection filtration'], 'Aseptic filling': ['injection filling'], 'Powder filling': ['injection.dpi filling.powder'], 'Lyophilisation': ['injection.lyo lyophilisation'],
  'Capping': ['injection capping'], 'Sterilisation': ['injection sterilisation'], 'Visual inspection': ['injection inspection'], 'Sterile packing': ['injection packing'],
  'Change room': ['* gowning.change_room'], 'Airlock': ['* gowning.airlock'], 'Sterile corridor': ['injection,biologics gowning.corridor'], 'Washing bay': ['* gowning.decon'],
  'Upstream': ['biologics upstream'], 'Media preparation': ['biologics upstream.media_prep'], 'Downstream': ['biologics downstream'], 'Buffer preparation': ['biologics downstream.buffer_prep'], 'Fill-finish': ['biologics filling'],
  'Semi-solid manufacturing': ['topical semisolid'], 'Phase preparation': ['topical phase_prep'], 'Gel preparation': ['topical.gel gel_prep'], 'Tube filling': ['topical tube_filling'], 'Semi-solid packing': ['topical packing'],
  'Sterile ophthalmic ointment': ['ophthalmic.ointment tube_filling.aseptic'], 'Ophthalmic compounding': ['ophthalmic compounding'], 'Ophthalmic filling': ['ophthalmic filling'],
  'Sterile eye drop suite': ['ophthalmic.drops,spray_drop.eye filling.aseptic_eye'], 'Nasal spray filling': ['spray_drop.nasal filling.nasal_pump'], 'Dropper filling': ['spray_drop filling.dropper'],
  'Aerosol filling': ['spray_drop.topical_spray.aerosol,inhalation.mdi filling.aerosol'], 'Spray testing': ['spray_drop,inhalation spray_testing'],
  'Coating and lamination': ['transdermal lamination'], 'Suppository moulding': ['suppository moulding'], 'MDI filling': ['inhalation.mdi inhaler_filling'], 'DPI filling': ['inhalation.dpi inhaler_filling'],
  'Liquid manufacturing': ['liquid compounding'], 'Syrup preparation': ['liquid.syrup syrup_prep'], 'Liquid storage': ['liquid transfer'], 'Liquid filtration': ['liquid filtration'], 'Bottle washing': ['liquid filling.bottle_washing'],
  'Liquid filling': ['liquid filling'], 'Liquid packing': ['liquid packing'],
  'API synthesis': ['api reaction'], 'Reaction': ['api reaction'], 'Kilo laboratory': ['api reaction'], 'Pilot plant': ['api reaction'], 'Production block': ['api reaction'], 'Flow chemistry': ['api reaction.flow'],
  'Hydrogenation': ['api reaction.batch.high_pressure'], 'Peptide synthesis': ['api.peptide reaction.spps'], 'Fermentation': ['api.fermentation reaction.fermentation'], 'Work-up': ['api workup'], 'Purification': ['api purification'],
  'API isolation': ['api isolation'], 'Final isolation (clean area)': ['api isolation'], 'Centrifuge': ['api isolation'], 'API drying': ['api drying'], 'Sterile API': ['api.sterile sterile_api'],
  'API milling': ['api milling'], 'Micronisation': ['api,inhalation.dpi milling.micronisation'], 'API blending': ['api blending'], 'API packing': ['api packing'], 'Solvent recovery': ['api solvent_recovery'],
  'Solvent tank farm': ['api solvent_recovery.storage'], 'Effluent treatment': ['api effluent.etp'],
  'Cyclotron vault': ['radiopharma.pet cyclotron'], 'Hot cell laboratory': ['radiopharma hot_cell'], 'Radiopharmacy dispensing': ['radiopharma shielded_dispensing'], 'Radio QC': ['radiopharma radio_qc'], 'Decay storage': ['radiopharma decay_storage'],
  'Utilities': ['common'], 'HVAC': ['common hvac'], 'Water system': ['common water'], 'Boiler house': ['common steam'], 'Compressed air': ['common gases'], 'Engineering': ['common engineering'],
  'Warehouse': ['common warehouse'], 'Sampling': ['common warehouse.sampling'], 'Cold room': ['common warehouse.cold_room'], 'Quarantine': ['common warehouse.quarantine'],
  'QC': ['qc general'], 'QC laboratory': ['qc general'], 'Instrument laboratory': ['qc chromatography'], 'Wet chemistry': ['qc general'], 'Microbiology': ['qc microbiology'], 'Stability': ['qc stability'],
};

/** For records without a type: the first hint whose pattern matches the name gives the type (stop-gap, see above). */
export const NAME_HINTS: Record<Kind, [RegExp, string][]> = {
  equipment: [
    [/bilayer/i, 'Bilayer tablet press'], [/double[- ]rotary/i, 'Double rotary tablet press'], [/tablet press|\bpress\b/i, 'Tablet press'],
    [/cold[- ]form|alu[- ]alu/i, 'Cold form blister machine'], [/blister/i, 'Blister packer'], [/strip pack/i, 'Strip packer'],
    [/cartoner|cartonator/i, 'Cartoner'], [/check ?weigh/i, 'Check weigher'], [/bottle/i, 'Bottle filling line'],
    [/coating pan|coater/i, 'Coater'], [/co-?mill|conical mill/i, 'Co-mill'], [/multi ?mill/i, 'Multimill'], [/\bmill\b/i, 'Mill'],
    [/octagonal/i, 'Octagonal blender'], [/bin blender/i, 'Bin blender'], [/blender/i, 'Blender'], [/granulator/i, 'Granulator'],
    [/fluid bed/i, 'Fluid bed dryer'], [/sifter/i, 'Sifter'], [/printer/i, 'Tablet printer'], [/dispensing/i, 'Dispensing booth'],
    [/autoclave/i, 'Autoclave'], [/lyophili[sz]er|freeze dryer/i, 'Lyophiliser'], [/vial wash/i, 'Vial washing machine'], [/capsule fill/i, 'Capsule filling machine'],
    [/\bahu\b|air handling/i, 'AHU'], [/purified water|water system/i, 'Water system'], [/compressor|compressed air/i, 'Compressor'],
  ],
  instrument: [
    [/hplc/i, 'HPLC'], [/\bgc\b/i, 'GC'], [/hardness/i, 'Hardness tester'], [/friab/i, 'Friabilator'], [/disintegration/i, 'Disintegration tester'],
    [/dissolution/i, 'Dissolution apparatus'], [/karl fischer|\bkf\b/i, 'Karl Fischer titrator'], [/titrator/i, 'Titrator'], [/ph meter/i, 'pH meter'],
    [/moisture|\blod\b/i, 'Moisture analyser'], [/leak tester/i, 'Leak tester'], [/metal detector/i, 'Metal detector'], [/torque/i, 'Torque tester'],
    [/spectrophotometer|\buv\b/i, 'Spectrophotometer'], [/balance/i, 'Balance'],
  ],
  area: [
    [/dispens/i, 'Dispensing'], [/granulat/i, 'Granulation'], [/blend/i, 'Blending'], [/compress/i, 'Compression'], [/coat/i, 'Coating'],
    [/capsule/i, 'Capsule filling'], [/inspect/i, 'Inspection'], [/pack/i, 'Packing'], [/warehouse|store/i, 'Warehouse'], [/sampling/i, 'Sampling'],
    [/micro/i, 'Microbiology'], [/\bqc\b|laborator/i, 'QC'], [/utilit|ahu|hvac/i, 'Utilities'], [/aseptic|filling/i, 'Aseptic filling'],
    [/wash/i, 'Vial washing'], [/lyo/i, 'Lyophilisation'], [/compounding/i, 'Sterile compounding'], [/airlock|change room|gowning/i, 'Airlock'],
  ],
};

/** Facility from a name (own name first, then the room's): every matching hint applies. */
export const FACILITY_HINTS: [RegExp, string][] = [
  [/penicillin/i, 'beta_lactam.penicillin'], [/cephalosporin|cephalexin|cefixime/i, 'beta_lactam.cephalosporin'], [/carbapenem|meropenem/i, 'beta_lactam.carbapenem'], [/beta[- ]?lactam/i, 'beta_lactam'],
  [/oncolog|cytotoxic|\bOEB\b|high[- ]potenc|\bHPAPI\b|anticancer/i, 'oncology'], [/hormon|steroid|contracept|dermatological steroid/i, 'hormones'], [/immunosuppress/i, 'immunosuppressants'],
  [/biologic|vaccine|\bBSL\b|bioreactor|mAb\b|biosimilar/i, 'biologics'], [/radiopharm|cyclotron|hot cell|\bPET\b|radiosynth|Tc-99m|shielded/i, 'radiopharma'],
  [/veterinar/i, 'veterinary'], [/nutraceutic|dietary supplement|food supplement/i, 'nutraceutical'], [/\bsterile\b|aseptic/i, 'sterile'],
];
const STERILE_FORMS = new Set(['injection', 'ophthalmic']);
/** The facility a form implies when no name says otherwise. */
export function defaultFacility(form: string | undefined): string {
  const root = (form ?? '').split('.')[0] ?? '';
  if (STERILE_FORMS.has(root)) return 'sterile';
  if (root === 'biologics') return 'biologics';
  if (root === 'radiopharma') return 'radiopharma';
  return 'general';
}

const lower = (t: string | null | undefined) => (t ?? '').trim().toLowerCase();
const byLowerKey = (table: Record<string, Specs>) => new Map(Object.entries(table).map(([k, v]) => [k.toLowerCase(), v]));
const LOOKUP: Record<Kind, Map<string, Specs>> = { equipment: byLowerKey(EQUIPMENT_TYPES), instrument: byLowerKey(INSTRUMENT_TYPES), area: byLowerKey(AREA_TYPES) };
const ROOT_FORMS = FORMS.map((f) => f.id);

/** Parses one spec into its paths. Exported for the unit test that checks every spec against the tree. */
export function expandSpec(kind: Kind, spec: string): Path[] {
  const [forms = '', process] = spec.trim().split(/\s+/);
  const list = forms === '*' ? ROOT_FORMS : forms.split(',').filter(Boolean);
  return list.map((f) => [kind, f, ...(process ? [process] : [])]);
}

export interface Classifiable { kind: Kind; type?: string | null; name?: string | null; grade?: string | null; roomArea?: string | null; roomName?: string | null }

/** The master-data type of a record: its own, else the one its name hints at (stop-gap for untyped records). */
export function typeOf(item: Classifiable): string | null {
  const own = (item.type ?? '').trim();
  if (own) return own;
  return NAME_HINTS[item.kind].find(([re]) => re.test(item.name ?? ''))?.[1] ?? null;
}

const dedupe = (paths: Path[]) => [...new Map(paths.map((p) => [p.join('/'), p])).values()];
/** Every path of an item; [kind, "other"] when its type is not in the table. */
export function pathsOf(item: Classifiable): Path[] {
  const type = lower(typeOf(item));
  const own = type ? LOOKUP[item.kind].get(type) : undefined;
  if (item.kind === 'instrument' && type && LOCATED_INSTRUMENTS.has(type) && item.roomArea) {
    const room = LOOKUP.area.get(lower(item.roomArea));
    if (room && !room.some((s) => s.startsWith('qc'))) {
      // Where it stands: the room's form and process, step "IPC" (a room without a process gives nothing to stand in).
      const placed = room.flatMap((s) => expandSpec('instrument', s)).filter((p) => p.length === 3).map((p) => [p[0]!, p[1]!, `${p[2]}.${IPC}`]);
      if (placed.length) return placed;
    }
  }
  if (!own) return [[item.kind, OTHER]];
  return dedupe(own.flatMap((s) => expandSpec(item.kind, s)));
}

/** The facilities of an item: from its name, else its room's name, else the default of its form(s). */
export function facilitiesOf(item: Classifiable, paths: Path[] = pathsOf(item)): string[] {
  const hits = (text: string | null | undefined) => FACILITY_HINTS.filter(([re]) => re.test(text ?? '')).map(([, f]) => f);
  let found = hits(item.name);
  if (!found.length) found = hits(item.roomName);
  if (!found.length) found = paths.map((p) => defaultFacility(p[1]));
  // A specific hit beats its branch (penicillin over beta-lactam) when both match the same name.
  const out = [...new Set(found)];
  return out.filter((f) => !out.some((g) => g !== f && g.startsWith(`${f}.`)));
}

/** Everything the filter needs about one item. */
export interface Classification { type: string | null; paths: Path[]; facilities: string[]; grade: string | null }
export function classify(item: Classifiable): Classification {
  const paths = pathsOf(item);
  return { type: typeOf(item), paths, facilities: facilitiesOf(item, paths), grade: item.kind === 'area' ? ((item.grade ?? '').trim() || null) : null };
}

/* ---- Trees and labels ---- */
const index = (nodes: Node[], into = new Map<string, Node>()): Map<string, Node> => { for (const x of nodes) { into.set(x.id, x); if (x.children) index(x.children, into); } return into; };
const FACILITY_NODE = index(FACILITIES);
const FORM_NODE = index(FORMS);
const PROCESS_NODE = index(PROCESSES);
export const facilityNode = (id: string) => FACILITY_NODE.get(id);
export const formNode = (id: string) => FORM_NODE.get(id);
export const processNode = (id: string) => PROCESS_NODE.get(id);
export const facilityLabel = (id: string) => (id === OTHER ? 'Other' : FACILITY_NODE.get(id)?.label ?? id);
export const formLabel = (id: string) => (id === OTHER ? 'Other' : FORM_NODE.get(id)?.label ?? id);
export function processLabel(id: string): string {
  if (id === OTHER) return 'Other';
  if (id.endsWith(`.${OTHER}`)) return 'Other / unspecified';
  if (id.endsWith(`.${IPC}`)) return 'In-process control (IPC)';
  return PROCESS_NODE.get(id)?.label ?? id.split('.').pop()!;
}
export const gradeLabel = (g: string) => (g.toUpperCase() === 'CNC' ? 'CNC (unclassified)' : `Grade ${g}`);

/* ---- Selection and matching ---- */
export interface Selection { kind: Kind | null; facility: string | null; form: string | null; process: string | null; grade: string | null }
export const NO_SELECTION: Selection = { kind: null, facility: null, form: null, process: null, grade: null };
export type Dimension = keyof Selection;

/** Two dotted ids meet when one is the other or lies under it (osd ~ osd.capsule.hard; osd.tablet !~ osd.capsule). */
export const meet = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
const under = (a: string, b: string) => a === b || a.startsWith(`${b}.`);

export interface Classified { paths: Path[]; facilities: string[]; grade?: string | null }
export function pathMatches(p: Path, s: Selection): boolean {
  if (s.kind && p[0] !== s.kind) return false;
  if (s.form) { const f = p[1]; if (s.form === OTHER ? f !== undefined && f !== OTHER : !f || f === OTHER || !meet(f, s.form)) return false; }
  if (s.process) {
    const q = p[2];
    if (s.process === OTHER) { if (q !== undefined && q !== OTHER) return false; }
    else if (s.process.endsWith(`.${OTHER}`)) { if (q !== s.process.slice(0, -OTHER.length - 1) && q !== s.process) return false; }
    else if (!q || !under(q, s.process)) return false;
  }
  return true;
}
export function itemMatches(i: Classified, s: Selection): boolean {
  if (s.facility && !i.facilities.some((f) => (s.facility === OTHER ? false : meet(f, s.facility!)))) return false;
  if (s.grade && (i.grade ?? null) !== s.grade) return false;
  return i.paths.some((p) => pathMatches(p, s));
}
export const count = <T extends Classified>(items: T[], s: Selection) => items.reduce((k, i) => k + (itemMatches(i, s) ? 1 : 0), 0);

/* ---- Rows of the cascading filter ---- */
export interface Option { id: string; label: string; count: number; to: Selection }
export interface Row { key: string; dimension: Dimension; label: string; current: string | null; all: Option; options: Option[] }

/** What choosing a value means: the dimension set, what depends on it cleared (process depends on form). */
export function withValue(s: Selection, d: Dimension, v: string | null): Selection {
  const next = { ...s, [d]: v } as Selection;
  if (d === 'form') next.process = null;
  if (d === 'kind' && v !== 'area') next.grade = null;
  return next;
}

/** A row per level of a dotted dimension: the roots, then the children of each chosen ancestor. */
function treeRows<T extends Classified>(items: T[], s: Selection, d: 'facility' | 'form' | 'process', roots: Node[], showAll: boolean, label: (id: string) => string, rowLabel: string): Row[] {
  const chosen = s[d];
  const nodeOf = d === 'facility' ? FACILITY_NODE : d === 'form' ? FORM_NODE : PROCESS_NODE;
  const option = (id: string): Option => { const to = withValue(s, d, id); return { id, label: label(id), count: count(items, to), to }; };
  // Ids present among the items at a given parent (so items placed outside the tree still show).
  const present = (parent: string | null): string[] => {
    const seen = new Set<string>();
    const depth = parent ? parent.split('.').length + 1 : 1;
    for (const i of items) {
      const values = d === 'facility' ? i.facilities : i.paths.map((p) => (d === 'form' ? p[1] : p[2]) ?? OTHER);
      for (const v of values) {
        if (parent === null) seen.add(v.split('.')[0]!);
        else if (v === parent && d === 'process') seen.add(`${parent}.${OTHER}`);
        else if (v.startsWith(`${parent}.`)) seen.add(v.split('.').slice(0, depth).join('.'));
      }
    }
    return [...seen];
  };
  const build = (parent: string | null, nodes: Node[]): Row => {
    const ids = [...nodes.map((x) => x.id)];
    for (const id of present(parent)) if (!ids.includes(id)) ids.push(id);
    const options = ids.map(option).filter((o) => o.count > 0 || o.id === chosen || (showAll && !o.id.endsWith(OTHER)))
      .sort((a, b) => (a.id.endsWith(OTHER) ? 1 : 0) - (b.id.endsWith(OTHER) ? 1 : 0));
    const node = parent ? nodeOf.get(parent) : undefined;
    const current = chosen && (parent === null ? chosen.split('.')[0]! : chosen.startsWith(`${parent}.`) ? chosen.split('.').slice(0, parent.split('.').length + 1).join('.') : null);
    const allTo = withValue(s, d, parent);
    return { key: `${d}:${parent ?? ''}`, dimension: d, label: node ? node.label : rowLabel, current: current ?? null,
      all: { id: parent ?? '', label: node ? `All ${node.label.charAt(0).toLowerCase()}${node.label.slice(1)}` : 'All', count: count(items, allTo), to: allTo }, options };
  };
  const rows = [build(null, roots)];
  if (chosen && chosen !== OTHER) {
    const parts = chosen.split('.');
    for (let i = 1; i < parts.length + 1; i++) {
      const id = parts.slice(0, i).join('.');
      if (id.endsWith(`.${OTHER}`) || id === OTHER) break;
      const kids = nodeOf.get(id)?.children ?? [];
      if (kids.length || present(id).length) rows.push(build(id, kids));
    }
  }
  return rows;
}

/**
 * The rows of the filter for a selection: kind; facility (tree); dosage form (tree); process (tree, once a form is
 * chosen; the family's processes when "show all"); grade (areas only). Options with no item are left out unless
 * `showAll`; the chosen one is always kept. Each option carries the selection that choosing it makes.
 */
export function filterRows<T extends Classified>(items: T[], s: Selection, showAll = false): Row[] {
  const kindRow: Row = { key: 'kind', dimension: 'kind', label: 'Kind', current: s.kind,
    all: { id: '', label: 'All', count: count(items, withValue(s, 'kind', null)), to: withValue(s, 'kind', null) },
    options: KINDS.map((k) => ({ id: k.id, label: k.label, count: count(items, withValue(s, 'kind', k.id)), to: withValue(s, 'kind', k.id) })) };
  const rows = [kindRow,
    ...treeRows(items, s, 'facility', FACILITIES, showAll, facilityLabel, 'Facility'),
    ...treeRows(items, s, 'form', FORMS, showAll, formLabel, 'Dosage form')];
  if (s.form && s.form !== OTHER) {
    const family = FAMILY_PROCESSES[s.form.split('.')[0]!] ?? [];
    rows.push(...treeRows(items, s, 'process', PROCESSES.filter((p) => family.includes(p.id)), showAll, processLabel, 'Process'));
  }
  if (s.kind === 'area') {
    const grades = [...new Set(items.filter((i) => i.grade).map((i) => i.grade!))].sort((a, b) => order(a) - order(b));
    rows.push({ key: 'grade', dimension: 'grade', label: 'Cleanroom grade', current: s.grade,
      all: { id: '', label: 'All', count: count(items, withValue(s, 'grade', null)), to: withValue(s, 'grade', null) },
      options: grades.map((g) => ({ id: g, label: gradeLabel(g), count: count(items, withValue(s, 'grade', g)), to: withValue(s, 'grade', g) })).filter((o) => o.count > 0 || o.id === s.grade) });
  }
  return rows;
}
const GRADE_ORDER = ['A', 'B', 'C', 'D', 'CNC'];
const order = (g: string) => { const k = GRADE_ORDER.indexOf(g.toUpperCase()); return k < 0 ? 99 : k; };

/** The breadcrumb of a selection: label and the selection that going back to that crumb restores. */
export function crumbs(s: Selection): { label: string; to: Selection }[] {
  const out: { label: string; to: Selection }[] = [];
  let acc: Selection = { ...NO_SELECTION };
  if (s.kind) { acc = { ...acc, kind: s.kind }; out.push({ label: KIND_LABEL[s.kind], to: acc }); }
  const chain = (d: 'facility' | 'form' | 'process', label: (id: string) => string) => {
    const v = s[d]; if (!v) return;
    const parts = v === OTHER ? [OTHER] : v.split('.');
    parts.forEach((_, i) => { const id = v === OTHER ? OTHER : parts.slice(0, i + 1).join('.'); acc = { ...acc, [d]: id }; out.push({ label: label(id), to: acc }); });
  };
  chain('facility', facilityLabel); chain('form', formLabel); chain('process', processLabel);
  if (s.grade) { acc = { ...acc, grade: s.grade }; out.push({ label: gradeLabel(s.grade), to: acc }); }
  return out;
}

/** "equipment/beta_lactam.penicillin/osd.tablet/coating.film/D" ⇄ Selection, for the URL hash. */
export const selectionToString = (s: Selection) => [s.kind, s.facility, s.form, s.process, s.grade].map((x) => x ?? '').join('/').replace(/\/+$/, '');
export function selectionFromString(text: string): Selection {
  const [kind, facility, form, process, grade] = text.split('/').map((x) => x.trim());
  const safe = (x: string | undefined) => (x && /^[a-z0-9_.:-]+$/i.test(x) ? x : null);
  const f = safe(form);
  return { kind: KINDS.find((x) => x.id === kind)?.id ?? null, facility: safe(facility), form: f, process: f ? safe(process) : null, grade: safe(grade) };
}
export const selectionIsEmpty = (s: Selection) => !s.kind && !s.facility && !s.form && !s.process && !s.grade;
