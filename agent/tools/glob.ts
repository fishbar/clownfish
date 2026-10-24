/** Minimal glob → RegExp converter (supports *, **, ?, case-insensitive on the filename). */
export function globToRegex(pattern: string, caseInsensitive = true): RegExp {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i++;
				if (pattern[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.+()|{}[]".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	re += "$";
	return new RegExp(re, caseInsensitive ? "i" : "");
}

export function matchGlob(pattern: string, name: string, caseInsensitive = true): boolean {
	return globToRegex(pattern, caseInsensitive).test(name);
}
