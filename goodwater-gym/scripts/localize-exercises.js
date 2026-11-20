const fs = require('fs');
const path = require('path');

const datasetPath = path.resolve(__dirname, '../data/exercises-dataset.json');
const exercises = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

const phrases = [
  ['45° side bend', 'flexion latérale à 45°'], ['air bike', 'vélo à résistance à air'],
  ['all fours', 'à quatre pattes'], ['heel touchers', 'toucher des talons'],
  ['ankle circles', 'rotations des chevilles'], ['arm slingers', 'balanciers des bras'],
  ['body weight', 'poids du corps'], ['bodyweight', 'poids du corps'],
  ['bench press', 'développé couché'], ['chest press', 'développé pectoraux'],
  ['shoulder press', 'développé épaules'], ['military press', 'développé militaire'],
  ['skull press', 'barre au front'], ['leg press', 'presse à cuisses'],
  ['deadlift', 'soulevé de terre'], ['good morning', 'good morning'],
  ['lat pulldown', 'tirage vertical'], ['pulldown', 'tirage vertical'],
  ['pushdown', 'extension à la poulie'], ['push-up', 'pompes'], ['push up', 'pompes'],
  ['pull-up', 'tractions'], ['pull up', 'tractions'], ['chin-up', 'tractions supination'],
  ['sit-up', 'relevé de buste'], ['sit up', 'relevé de buste'],
  ['calf raise', 'élévation des mollets'], ['front raise', 'élévation frontale'],
  ['lateral raise', 'élévation latérale'], ['rear delt', 'deltoïde postérieur'],
  ['hip thrust', 'poussée de hanches'], ['hip extension', 'extension de hanches'],
  ['leg extension', 'extension des jambes'], ['leg curl', 'flexion des jambes'],
  ['wrist curl', 'flexion des poignets'], ['preacher curl', 'curl au pupitre'],
  ['hammer curl', 'curl marteau'], ['concentration curl', 'curl concentré'],
  ['biceps curl', 'curl biceps'], ['bicep curl', 'curl biceps'],
  ['triceps extension', 'extension triceps'], ['tricep extension', 'extension triceps'],
  ['bent over', 'penché'], ['close grip', 'prise serrée'], ['wide grip', 'prise large'],
  ['reverse grip', 'prise inversée'], ['neutral grip', 'prise neutre'],
  ['one arm', 'unilatéral'], ['single arm', 'unilatéral'], ['two arm', 'à deux bras'],
  ['one leg', 'unilatéral'], ['single leg', 'unilatéral'], ['straight leg', 'jambes tendues'],
  ['exercise ball', 'ballon de fitness'], ['stability ball', 'ballon de stabilité'],
  ['medicine ball', 'médecine-ball'], ['smith machine', 'machine Smith'],
  ['upper back', 'haut du dos'], ['lower back', 'bas du dos'],
  ['behind head', 'derrière la tête'], ['overhead', 'au-dessus de la tête'],
  ['incline bench', 'banc incliné'], ['decline bench', 'banc décliné'],
  ['with rope attachment', 'avec corde'], ['rope attachment', 'avec corde'],
  ['alternate', 'alterné'], ['alternating', 'alterné'],
];

const words = {
  dumbbell:'haltères', dumbbells:'haltères', barbell:'barre', cable:'poulie', band:'élastique',
  kettlebell:'kettlebell', lever:'machine', weighted:'lesté', assisted:'assisté', smith:'Smith',
  machine:'machine', sled:'traîneau', roller:'rouleau', rope:'corde', towel:'serviette',
  bench:'banc', ball:'ballon', bar:'barre', wheel:'roue', bosu:'BOSU',
  seated:'assis', standing:'debout', lying:'allongé', kneeling:'à genoux', hanging:'suspendu',
  prone:'ventral', supine:'sur le dos', vertical:'vertical', horizontal:'horizontal',
  incline:'incliné', decline:'décliné', upright:'vertical', bent:'penché', forward:'avant',
  backward:'arrière', rear:'arrière', front:'avant', lateral:'latéral', side:'latéral',
  reverse:'inversé', straight:'tendu', wide:'large', narrow:'serré', close:'serré',
  high:'haut', low:'bas', full:'complet', parallel:'parallèle', inner:'intérieur', outer:'extérieur',
  arm:'bras', arms:'bras', leg:'jambe', legs:'jambes', shoulder:'épaule', shoulders:'épaules',
  chest:'pectoraux', back:'dos', biceps:'biceps', bicep:'biceps', triceps:'triceps', tricep:'triceps',
  calf:'mollets', calves:'mollets', hamstring:'ischio-jambiers', glute:'fessiers', glutes:'fessiers',
  hip:'hanche', hips:'hanches', waist:'taille', neck:'cou', wrist:'poignet', wrists:'poignets',
  elbow:'coude', elbows:'coudes', knee:'genou', knees:'genoux', toe:'orteils', feet:'pieds',
  hand:'main', hands:'mains', head:'tête', abdominal:'abdominal', abs:'abdominaux', delt:'deltoïde',
  press:'développé', row:'rowing', raise:'élévation', extension:'extension', curl:'curl', curls:'curls',
  squat:'squat', lunge:'fente', crunch:'crunch', fly:'écarté', dip:'dips', dips:'dips',
  pullover:'pull-over', shrug:'haussement', bridge:'pont', plank:'gainage', twist:'rotation',
  rotation:'rotation', stretch:'étirement', jump:'saut', run:'course', sprint:'sprint',
  clean:'épaulé', snatch:'arraché', kickback:'kickback', adduction:'adduction', abduction:'abduction',
  pull:'tirage', push:'poussée', lift:'élévation', touch:'toucher', tap:'toucher', throw:'lancer',
  roll:'roulement', rollout:'déploiement', rollerout:'déploiement au rouleau', bend:'flexion',
  split:'fente', step:'pas', walking:'marché', walk:'marche', climbing:'montée',
  air:'air', bike:'vélo', heel:'talon', heels:'talons', toucher:'toucher', touchers:'touchers',
  ankle:'cheville', ankles:'chevilles', circle:'cercle', circles:'cercles', archer:'archer',
  apart:'écartés', fours:'quatre appuis', squad:'squat', slingers:'balanciers', skin:'peau', cat:'chat',
  floor:'sol', rack:'support', clock:'horloge', pelvic:'pelvien', tilt:'bascule', wind:'vent',
  mountain:'montagne', climber:'grimpeur', donkey:'âne', kick:'coup de pied', jack:'écart',
  handstand:'équilibre sur les mains', wall:'mur', pike:'brochet', spider:'araignée',
  concentration:'concentré', preacher:'pupitre', hammer:'marteau', hack:'hack', sumo:'sumo',
  stiff:'raide', scapular:'scapulaire', scapula:'omoplate', muscle:'muscle', blaster:'isolateur',
  head:'tête', rack:'support', floor:'sol', position:'position', hold:'maintien',
  grip:'prise', palms:'paumes', palm:'paume', hands:'mains', stance:'position', support:'support',
  male:'homme', female:'femme', russian:'russe', circular:'circulaire', twisting:'avec rotation',
  suspended:'suspendu', resistance:'résistance', isometric:'isométrique', dynamic:'dynamique',
  on:'sur', with:'avec', to:'vers', and:'et', into:'en', against:'contre', from:'depuis',
  over:'au-dessus', under:'sous', behind:'derrière', between:'entre', around:'autour',
  up:'haut', down:'bas', a:'un', the:'le', v:'version', exercise:'exercice',
};

function translateName(name) {
  let translated = ` ${name.toLowerCase()} `;
  const protectedPhrases = [];
  for (const [english, french] of phrases.sort((a, b) => b[0].length - a[0].length)) {
    const marker = `§${protectedPhrases.length}§`;
    const next = translated.replace(new RegExp(`\\b${english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), marker);
    if (next !== translated) protectedPhrases.push(french);
    translated = next;
  }
  translated = translated.replace(/\b[a-z]+\b/g, word => words[word] || word);
  translated = translated.replace(/§(\d+)§/g, (_, index) => protectedPhrases[Number(index)]);
  translated = translated.replace(/\s+/g, ' ').replace(/\s+([),])/g, '$1').replace(/([(])\s+/g, '$1').trim();
  return translated.charAt(0).toLocaleUpperCase('fr') + translated.slice(1);
}

for (const exercise of exercises) exercise.name_fr = translateName(exercise.name);
fs.writeFileSync(datasetPath, JSON.stringify(exercises));
console.log(`${exercises.length} noms d’exercices francisés.`);
