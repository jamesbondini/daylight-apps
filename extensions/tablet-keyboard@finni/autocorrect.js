// Small, safe autocorrections: missing apostrophes, a lone "i" and common
// typos. Only words that are never correct as typed are listed.

const FIXES = {
    i: 'I',
    "i'm": "I'm", "i've": "I've", "i'd": "I'd", "i'll": "I'll",
    im: "I'm", ive: "I've",
    dont: "don't", doesnt: "doesn't", didnt: "didn't",
    cant: "can't", couldnt: "couldn't", wont: "won't", wouldnt: "wouldn't",
    shouldnt: "shouldn't", mustnt: "mustn't", neednt: "needn't",
    isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't",
    hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", aint: "ain't",
    youre: "you're", youve: "you've", youll: "you'll", youd: "you'd",
    theyre: "they're", theyve: "they've", theyll: "they'll", theyd: "they'd",
    weve: "we've", hes: "he's", shes: "she's",
    thats: "that's", whats: "what's", wheres: "where's", whos: "who's",
    theres: "there's", heres: "here's", hows: "how's", yall: "y'all",
    teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', tahn: 'than',
    thier: 'their', wich: 'which', whcih: 'which', becuase: 'because',
    becasue: 'because', recieve: 'receive', recieved: 'received',
    beleive: 'believe', freind: 'friend', freinds: 'friends', wierd: 'weird',
    alot: 'a lot', definately: 'definitely', seperate: 'separate',
    untill: 'until', occured: 'occurred', tommorow: 'tomorrow',
    tomorow: 'tomorrow', goverment: 'government', acheive: 'achieve',
    accomodate: 'accommodate', begining: 'beginning', calender: 'calendar',
    enviroment: 'environment', existance: 'existence', foriegn: 'foreign',
    knowlege: 'knowledge', neccessary: 'necessary', necesary: 'necessary',
    noticable: 'noticeable', occassion: 'occasion', persue: 'pursue',
    posible: 'possible', realy: 'really', remeber: 'remember',
    succesful: 'successful', suprise: 'surprise', truely: 'truly',
    wiht: 'with', whit: 'with', jsut: 'just', konw: 'know', knwo: 'know',
    ahve: 'have', waht: 'what', thnaks: 'thanks', thx: 'thanks',
};

// The word right before the end of `text`, if it is one we fix.
// Returns {original, replacement} or null.
export function findCorrection(text) {
    const match = text.match(/(?:^|[^\p{L}\p{N}'’])([\p{L}'’]+)$/u);
    if (!match)
        return null;

    const original = match[1];
    const fixed = FIXES[original.toLowerCase().replace(/’/g, "'")];
    if (!fixed)
        return null;

    let replacement = fixed;
    if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase())
        replacement = fixed.toUpperCase();
    else if (original[0] !== original[0].toLowerCase())
        replacement = fixed[0].toUpperCase() + fixed.slice(1);
    // Keep the typed apostrophe style
    if (original.includes('’'))
        replacement = replacement.replace(/'/g, '’');

    return replacement === original ? null : {original, replacement};
}
