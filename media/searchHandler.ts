// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { messageHandler, virtualHexDocument } from "./hexEdit";
import { SelectHandler } from "./selectHandler";
import { hexQueryToArray } from "./util";

interface SearchOptions {
    regex: boolean;
    caseSensitive: boolean;
    showResults: boolean;
}

interface SearchResults {
    result: number[][];
    partial: boolean;
}

export class SearchHandler {
    private searchResults: number[][];
    private searchType: "hex" | "ascii" = "hex";
    private searchOptions: SearchOptions;
    private resultIndex = 0;
    private findTextBox: HTMLInputElement;
    private replaceTextBox: HTMLInputElement;
    private replaceButton: HTMLSpanElement;
    private replaceAllButton: HTMLSpanElement;
    private preserveCase = false;
    private findPreviousButton: HTMLSpanElement;
    private findNextButton: HTMLSpanElement;
    private stopSearchButton: HTMLSpanElement;
    private resultsGrid: HTMLDivElement;
    private pageNextButton: HTMLSpanElement;
    private pagePrevButton: HTMLSpanElement;
    private pageIndex = 0;
    private pages = 0;
    private pageLength = 100;

    constructor() {
        this.searchResults = [];
        this.searchOptions = {
            regex: false,
            caseSensitive: false,
            showResults: false
        };
        this.findTextBox = document.getElementById("find") as HTMLInputElement;
        this.replaceTextBox = document.getElementById("replace") as HTMLInputElement;
        this.replaceButton = document.getElementById("replace-btn") as HTMLSpanElement;
        this.replaceAllButton = document.getElementById("replace-all") as HTMLSpanElement;
        this.findPreviousButton = document.getElementById("find-previous") as HTMLSpanElement;
        this.findNextButton = document.getElementById("find-next") as HTMLSpanElement;
        this.stopSearchButton = document.getElementById("search-stop") as HTMLSpanElement;
        this.resultsGrid = document.getElementById("search-grid") as HTMLDivElement;
        this.pageNextButton = document.getElementById("page-next") as HTMLSpanElement;
        this.pagePrevButton = document.getElementById("page-previous") as HTMLSpanElement;
        this.pageNextButton.addEventListener("click", () => this.pageNext());
        this.pagePrevButton.addEventListener("click", () => this.pagePrevious());
        this.findNextButton.addEventListener("click", () => this.findNext(true));
        this.findPreviousButton.addEventListener("click", () => this.findPrevious(true));
        this.updateInputGlyphs();
        // Whenever the user changes the data type we update the type we're searching for and the glyphs on the input box
        document.getElementById("data-type")?.addEventListener("change", (event: Event) => {
            const selectedValue = (event.target as HTMLSelectElement).value as "hex" | "ascii";
            this.searchType = selectedValue;
            this.updateInputGlyphs();
            this.search();
        });

        this.searchOptionsHandler();
        this.replaceOptionsHandler();

        // When the user presses a key trigger a search
        this.findTextBox.addEventListener("keyup", (event: KeyboardEvent) => {
            // Some VS Code keybinding defualts for find next, find previous, and focus restore
            if ((event.key === "Enter" || event.key === "F3") && event.shiftKey) {
                this.findPrevious(false);
            } else if (event.key === "Enter" || event.key === "F3") {
                this.findNext(false);
            } else if (event.key === "Escape") {
                // Pressing escape returns focus to the editor
                const selected = document.getElementsByClassName(`selected ${this.searchType}`)[0] as HTMLSpanElement | undefined;
                if (selected !== undefined) {
                    selected.focus();
                } else {
                    virtualHexDocument.focusElementWithGivenOffset(virtualHexDocument.topOffset());
                }
            } else if (event.ctrlKey || new RegExp("(^Arrow|^End|^Home)", "i").test(event.key)) {
                // If it's any sort of navigation key we don't want to trigger another search as nothing has changed
                return;
            } else {
                this.search();
            }
        });
        window.addEventListener("keyup", (event: KeyboardEvent) => {
            // Fin previous + find next when widget isn't focused
            if (event.key === "F3" && event.shiftKey && document.activeElement !== this.findTextBox) {
                this.findPrevious(true);
                event.preventDefault();
            } else if (event.key === "F3" && document.activeElement !== this.findTextBox) {
                this.findNext(true);
                event.preventDefault();
            }
        });

        this.replaceTextBox.addEventListener("keyup", this.updateReplaceButtons.bind(this));
        this.replaceButton.addEventListener("click", () => this.replace(false));
        this.replaceAllButton.addEventListener("click", () => this.replace(true));
        this.stopSearchButton.addEventListener("click", this.cancelSearch.bind(this));
        // Hide the message boxes for now as at first we have no messages to display
        document.getElementById("find-message-box")!.hidden = true;
        document.getElementById("replace-message-box")!.hidden = true;

    }

    /**
     * @description Sends a search request to the exthost
     */
    private async search(): Promise<void> {
        // If the box is empty no need to display any warnings
        if (this.findTextBox.value === "") this.removeInputMessage("find");
        // This gets called to cancel any searches that might be going on now
        this.cancelSearch();
        virtualHexDocument.setSelection([]);
        this.searchResults = [];
        this.clearResultTable();
        this.updateReplaceButtons();
        this.findNextButton.classList.add("disabled");
        this.findPreviousButton.classList.add("disabled");
        this.pageNextButton.classList.add("disabled");
        this.pagePrevButton.classList.add("disabled");
        const resultCount = document.getElementById("result-count");
        resultCount!.innerText = "";
        const pageDisplay = document.getElementById("display-page-index");
        pageDisplay!.innerText = "";
        let query: string | string[] = this.findTextBox.value;
        const hexSearchRegex = new RegExp("^[a-fA-F0-9? ]+$");
        // We check to see if the hex is a valid query else we don't allow a search
        if (this.searchType === "hex" && !hexSearchRegex.test(query)) {
            if (query.length > 0) this.addInputMessage("find", "Invalid query", "error");
            return;
        }
        // Test if it's a valid regex
        if (this.searchOptions.regex) {
            try {
                new RegExp(query);
            } catch (err) {
                // Split up the error message to fit in the box. In the future we might want the box to do word wrapping
                // So that it's not a manual endeavor
                const message = (err.message as string).substr(0, 27) + "\n" + (err.message as string).substr(27);
                this.addInputMessage("find", message, "error");
                return;
            }
        }
        query = this.searchType === "hex" ? hexQueryToArray(query) : query;
        if (query.length === 0) {
            // If the user didn't type anything and its just a blank query we don't want to error on them
            if (this.findTextBox.value.length > 0) this.addInputMessage("find", "Invalid query", "error");
            return;
        }
        this.stopSearchButton.classList.remove("disabled");
        let results: SearchResults;
        this.removeInputMessage("find");
        // This is wrapped in a try catch because if the message handler gets backed up this will reject
        try {
            results = (await messageHandler.postMessageWithResponse("search", {
                query: query,
                type: this.searchType,
                options: this.searchOptions
            }) as { results: SearchResults}).results;
        } catch(err) {
            this.stopSearchButton.classList.add("disabled");
            this.addInputMessage("find", "Search returned an error!", "error");
            return;
        }
        if (results.partial) {
            this.addInputMessage("find", "Partial results returned, try\n narrowing your query.", "warning");
        }
        this.stopSearchButton.classList.add("disabled");
        this.resultIndex = 0;
        this.pageIndex = 0;
        this.searchResults = results.result;
        this.pages = Math.ceil(this.searchResults.length / this.pageLength);
        // If we got results then we select the first result and unlock the buttons
        if (this.searchResults.length !== 0) {
            await virtualHexDocument.scrollDocumentToOffset(this.searchResults[this.resultIndex][0]);
            virtualHexDocument.setSelection(this.searchResults[this.resultIndex]);
            // If there's more than one search result we unlock the find next button
            if (this.resultIndex + 1 < this.searchResults.length) {
                this.findNextButton.classList.remove("disabled");
            }
            this.updateReplaceButtons();
            // Fill table with results entries.
            if (this.pages > 1) {
                this.pageNextButton.classList.remove("disabled");
            }
            // Update the search results list
            this.updateSearchResults(this.pageIndex);
        }
    }

    /**
     * @description Handles when the user clicks the find next icon
     * @param {boolean} focus Whether or not to focus the selection
     */
    private async findNext(focus: boolean): Promise<void> {
        // If the button is disabled then this function shouldn't work
        if (this.findNextButton.classList.contains("disabled")) return;
        await virtualHexDocument.scrollDocumentToOffset(this.searchResults[++this.resultIndex][0]);
        virtualHexDocument.setSelection(this.searchResults[this.resultIndex]);
        if (focus) SelectHandler.focusSelection(this.searchType);
        // If there's more than one search result we unlock the find next button
        if (this.resultIndex < this.searchResults.length - 1) {
            this.findNextButton.classList.remove("disabled");
        } else {
            this.findNextButton.classList.add("disabled");
        }
        // We also unlock the find previous button if there is a previous
        if (this.resultIndex != 0) {
            this.findPreviousButton.classList.remove("disabled");
        }
        // Update the search results list
        this.updateSearchResults(this.pageIndex);
    }

    /**
     * @description Handles when the user clicks the find previous icon
     * @param {boolean} focus Whether or not to focus the selection
     */
    private async findPrevious(focus: boolean): Promise<void> {
        // If the button is disabled then this function shouldn't work
        if (this.findPreviousButton.classList.contains("disabled")) return;
        await virtualHexDocument.scrollDocumentToOffset(this.searchResults[--this.resultIndex][0]);
        virtualHexDocument.setSelection(this.searchResults[this.resultIndex]);
        if (focus) SelectHandler.focusSelection(this.searchType);
        // If they pressed previous, they can always go next therefore we always unlock the next button
        this.findNextButton.classList.remove("disabled");
        // We lock the find previous if there isn't a previous anymore
        if (this.resultIndex == 0) {
            this.findPreviousButton.classList.add("disabled");
        }
        // Update the search results list
        this.updateSearchResults(this.pageIndex);
    }

    /**
     * @description Handles when the user toggels between text and hex showing the input glyphs and ensureing correct padding
     */
    private updateInputGlyphs(): void {
        // The glyph icons that sit in the find and replace bar
        const inputGlyphs = document.getElementsByClassName("bar-glyphs") as HTMLCollectionOf<HTMLSpanElement>;
        const inputFields = document.querySelectorAll(".bar > .input-glyph-group > input") as NodeListOf<HTMLInputElement>;
        if (this.searchType == "hex") {
            inputGlyphs[0].hidden = true;
            inputGlyphs[1].hidden = true;
            document.documentElement.style.setProperty("--input-glyph-padding", "0px");
        } else {
            for (let i = 0; i < inputGlyphs.length; i++) {
                inputGlyphs[i].hidden = false;
            }
            const glyphRect = inputGlyphs[0].getBoundingClientRect();
            const inputRect = inputFields[0].getBoundingClientRect();
            // Calculates how much padding we should have so that the text doesn't run into the glyphs
            const inputPadding = (inputRect.x + inputRect.width + 1) - glyphRect.x;
            document.documentElement.style.setProperty("--input-glyph-padding", `${inputPadding}px`);
        }
    }

    /**
     * @description Handles listening to the search options and updating them
     */
    private searchOptionsHandler(): void {
        // Toggle Regex
        document.getElementById("regex-icon")?.addEventListener("click", (event: MouseEvent) => {
            const regexIcon = event.target as HTMLSpanElement;
            if (regexIcon.classList.contains("toggled")) {
                this.searchOptions.regex = false;
                regexIcon.classList.remove("toggled");
            } else {
                this.searchOptions.regex = true;
                regexIcon.classList.add("toggled");
            }
            // The user is changing an option so we should trigger another search
            this.search();
        });
        // Toggle case sensitive
        document.getElementById("case-sensitive")?.addEventListener("click", (event: MouseEvent) => {
            const caseSensitive = event.target as HTMLSpanElement;
            if (caseSensitive.classList.contains("toggled")) {
                this.searchOptions.caseSensitive = false;
                caseSensitive.classList.remove("toggled");
            } else {
                this.searchOptions.caseSensitive = true;
                caseSensitive.classList.add("toggled");
            }
            // The user is changing an option so we should trigger another search
            this.search();
        });
        // Toggle Search Results List
        document.getElementById("results-list-button")?.addEventListener("click", (event: MouseEvent) => {
            const toggleResults = event.target as HTMLSpanElement;
            const resultsDiv = document.getElementById("search-results-widget");
            if (toggleResults.classList.contains("toggled")) {
                toggleResults.classList.remove("toggled");
                resultsDiv?.classList.add("disable-results");
                this.searchOptions.showResults = false;
            } else {
                toggleResults.classList.add("toggled");
                resultsDiv?.classList.remove("disable-results");
                this.searchOptions.showResults = true;
                this.updateSearchResults(this.pageIndex);
            }
            // The user is changing an option so we should trigger another search
            //this.search();
        });
    }

    /**
     * @description Populate search result table for page number
     * @param {number} newPage The new pageIndex to display
     */
    private async updateSearchResults(newPage: number): Promise<void> {
        this.clearResultTable();
        // If going to a page out of range, return. This shouldn't happen, but YOLO.
        if (newPage >= this.pages || newPage < 0) return;
        this.pageIndex = newPage;
        
        // Display page and result count
        const resultCount = document.getElementById("result-count");
        resultCount!.innerText = this.searchResults.length.toString() + " results";

        const pageDisplay = document.getElementById("display-page-index");
        pageDisplay!.innerText = (this.pageIndex + 1).toString()+" / "+this.pages.toString();

        let entrycount = this.pageLength;
        let entryId = 0;
        let entryDiv = null;
        let entryIn = null;

        // If last page, get actual count, if less than pageLength
        if (this.pageIndex == this.pages - 1) {
            entrycount = this.searchResults.length % this.pageLength;
        }

        for(let i = 0; i < entrycount; i++) {
            // Add a result entry to the table
            // Create entry for this.searchResults[(this.pageLength*this.pageIndex)+i]
            entryId = (this.pageIndex*this.pageLength)+i;
            // Build a <div> for each entry
            entryDiv = document.createElement("div");
            entryDiv.classList.add("search-grid-item");
            entryDiv.setAttribute("id", "div_"+entryId.toString());
            // Build an <input> element for each entry
            entryIn = document.createElement("input");
            entryIn.type = "text";
            entryIn.readOnly = true;
            entryIn.value = "0x" + this.searchResults[entryId][0].toString(16).padStart(8, "0").toUpperCase();
            entryIn.classList.add("search-grid-input");
            entryIn.setAttribute("autocomplete", "off");
            entryIn.setAttribute("spellcheck", "off");
            entryIn.setAttribute("id", "entry_"+entryId.toString());
            // If the current resultIndex is on this page, set it to selected.
            if (entryId == this.resultIndex){
                entryIn.classList.add("search-selected");
            }
            // Add a selection handler to the entry Div
            entryIn.addEventListener("click", async (event: MouseEvent) => {
                const entry_target = event.target as HTMLDivElement;
                const entryId = Number(entry_target.getAttribute("id")?.split("_")[1]);
                // Unselect prior selected entry, if it exists in the DOM; update resultIndex and select.
                this.resultsGrid.querySelector("#entry_"+this.resultIndex.toString())?.classList.remove("search-selected");
                this.resultIndex = entryId;
                this.resultsGrid.querySelector("#entry_"+this.resultIndex.toString())?.classList.add("search-selected");
                // Set selection
                await virtualHexDocument.scrollDocumentToOffset(this.searchResults[this.resultIndex][0]);
                virtualHexDocument.setSelection(this.searchResults[this.resultIndex]);
                // Toggle next/previous buttons.
                if (this.resultIndex == 0) {
                    this.findPreviousButton.classList.add("disabled");
                } else {
                    this.findPreviousButton.classList.remove("disabled");
                }
                if (this.resultIndex < this.searchResults.length - 1) {
                    this.findNextButton.classList.remove("disabled");
                } else {
                    this.findNextButton.classList.add("disabled");
                }
            });
            // Add event listeners for hovering over search list entries.
            entryIn.addEventListener("mouseover", async (event: MouseEvent) => {
                if (!event || !event.target) return [];
                const hovered = event.target as Element;
                hovered.classList.toggle("hover");
            });
            entryIn.addEventListener("mouseleave", async (event: MouseEvent) => {
                if (!event || !event.target) return [];
                const hovered = event.target as Element;
                hovered.classList.toggle("hover");
            });
            entryDiv.appendChild(entryIn);
            this.resultsGrid.appendChild(entryDiv);
        }
        if (entrycount < this.pageLength) {
            for (let i = 0; i < this.pageLength - entrycount; i++) {
                const dummyDiv = document.createElement("div");
                dummyDiv.classList.add("search-grid-item");
                dummyDiv.setAttribute("id", "dummy_"+i.toString());
                this.resultsGrid.appendChild(dummyDiv);
            }
        }
    }

    /**
     * @description Clears the contents of the search grid container
     */
    private clearResultTable(): void {
        // Remove the results elements
        while (this.resultsGrid?.lastChild) {
            this.resultsGrid.removeChild(this.resultsGrid.lastChild);
            }
        }

    /**
     * @description Handles when the user clicks the page next icon
     */
    private async pageNext(): Promise<void> {
        // If the button is disabled then this function shouldn't work
        if (this.pageNextButton.classList.contains("disabled")) return;
        // Change current page and update table
        this.updateSearchResults(this.pageIndex+1);
        // If there's more than one page we unlock the next page button
        if (this.pageIndex < this.pages - 1) {
            this.pageNextButton.classList.remove("disabled");
        } else {
            this.pageNextButton.classList.add("disabled");
        }
        // We also unlock the previous page button, if there is a previous page.
        if (this.pageIndex != 0) {
            this.pagePrevButton.classList.remove("disabled");
        }
    }

    /**
     * @description Handles when the user clicks the page previous icon
     */
    private async pagePrevious(): Promise<void> {
        // If the button is disabled then this function shouldn't work
        if (this.pagePrevButton.classList.contains("disabled")) return;
        // Change current page and update table
        this.updateSearchResults(this.pageIndex-1);
        // If they pressed previous, they can always go next therefore we always unlock the next page button
        this.pageNextButton.classList.remove("disabled");
        // We lock the page previous if there isn't a previous anymore
        if (this.pageIndex == 0) {
            this.pagePrevButton.classList.add("disabled");
        }
    }

    private replaceOptionsHandler(): void {
        // Toggle preserve case
        document.getElementById("preserve-case")?.addEventListener("click", (event: MouseEvent) => {
            const preserveCase = event.target as HTMLSpanElement;
            if (preserveCase.classList.contains("toggled")) {
                this.preserveCase = false;
                preserveCase.classList.remove("toggled");
            } else {
                this.preserveCase = true;
                preserveCase.classList.add("toggled");
            }
        });
    }

    /**
     * @description Handles when the user hits the stop search button
     */
    private cancelSearch(): void {
        if (this.stopSearchButton.classList.contains("disabled")) return;
        // We don't want the user to keep executing this, so we disable the button after the first search
        this.stopSearchButton.classList.add("disabled");
        // We send a cancellation message to the exthost, there's no need to  wait for a response
        // As we're not expecting anything back just to stop processing the search
        messageHandler.postMessageWithResponse("search", { cancel: true });
    }

    /**
     * @description Helper function which handles locking / unlocking the replace buttons
     */
    private updateReplaceButtons(): void {
        this.removeInputMessage("replace");
        const hexReplaceRegex = new RegExp("^[a-fA-F0-9]+$");
        // If it's not a valid hex query we lock the buttons, we remove whitespace from the string to simplify the regex
        const queryNoSpaces = this.replaceTextBox.value.replace(/\s/g, "");
        if (this.searchType === "hex" && !hexReplaceRegex.test(queryNoSpaces)) {
            this.replaceAllButton.classList.add("disabled");
            this.replaceButton.classList.add("disabled");
            if (this.replaceTextBox.value.length > 0) this.addInputMessage("replace", "Invalid replacement", "error");
            return;
        }
        const replaceQuery = this.replaceTextBox.value;
        const replaceArray = this.searchType === "hex" ? hexQueryToArray(replaceQuery) : Array.from(replaceQuery);
        if (this.searchResults.length !== 0 && replaceArray.length !== 0) {
            this.replaceAllButton.classList.remove("disabled");
            this.replaceButton.classList.remove("disabled");
        } else {
            if (this.replaceTextBox.value.length > 0 && replaceArray.length === 0) this.addInputMessage("replace", "Invalid replacement", "error");
            this.replaceAllButton.classList.add("disabled");
            this.replaceButton.classList.add("disabled");
        }
    }

    /**
     * @description Handles when the user clicks replace or replace all
     * @param {boolean} all whether this is a normal replace or a replace all
     */
    private async replace(all: boolean): Promise<void> {
        const replaceQuery = this.replaceTextBox.value;
        const replaceArray = this.searchType === "hex" ? hexQueryToArray(replaceQuery) : Array.from(replaceQuery);
        let replaceBits: number[] = [];
        // Since the exthost only holds data in 8 bit unsigned ints we must convert it back
        if (this.searchType === "hex") {
            replaceBits = replaceArray.map(val => parseInt(val, 16));
        } else {
            replaceBits = replaceArray.map(val => val.charCodeAt(0));
        }

        let offsets: number[][] = [];
        if (all) {
            offsets = this.searchResults;
        } else {
            offsets = [this.searchResults[this.resultIndex]];
        }

        const edits = (await messageHandler.postMessageWithResponse("replace", {
            query: replaceBits,
            offsets: offsets,
            preserveCase: this.preserveCase
        })).edits;
        // We can pass the size of the document back in because with the current implementation
        // The size of the document will never change as we only replace preexisting cells
        virtualHexDocument.redo(edits, virtualHexDocument.documentSize);
        this.findNext(true);
    }

    /**
     * @description Function responsible for handling when the user presses cmd / ctrl + f updating the widget and focusing it
     */
    public searchKeybindingHandler(): void {
        this.searchType = document.activeElement?.classList.contains("ascii") ? "ascii" : "hex";
        const dataTypeSelect = (document.getElementById("data-type") as HTMLSelectElement);
        dataTypeSelect.value = this.searchType;
        dataTypeSelect.dispatchEvent(new Event("change"));
        this.findTextBox.focus();
    }

    /**
     * @description Adds an warning / error message to the input box passed in
     * @param {"find" | "replace"} inputBoxName Whether it's the find input box or the replace input box
     * @param {string} message The message to display
     * @param {"error" | "warning"} type Whether it's an error message or a warning message
     */
    private addInputMessage(inputBoxName: "find" | "replace", message: string, type: "error" | "warning"): void {
        const inputBox: HTMLInputElement = inputBoxName === "find" ? this.findTextBox : this.replaceTextBox;
        const messageBox = document.getElementById(`${inputBoxName}-message-box`) as HTMLDivElement;
        // We try to do the least amount of DOM changing as to reduce the flashing the user sees
        if (messageBox.innerText === message && messageBox.classList.contains(`input-${type}`)) {
            return;
        } else if (messageBox.classList.contains(`input-${type}`)) {
            messageBox.innerText = message;
            return;
        } else {
            this.removeInputMessage("find", true);
            messageBox.innerText = message;
            // Add the classes for proper styling of the message
            inputBox.classList.add(`${type}-border`);
            messageBox.classList.add(`${type}-border`, `input-${type}`);
            messageBox.hidden = false;
        }
    }

    /**
     * @description Removes the warning / error message
     * @param {"find" | "replace"} inputBoxName Which input box to remove the message from
     * @param {boolean | undefined} skipHiding Whether we want to skip hiding the empty message box, this is useful for clearing the box to add new text
     */
    private removeInputMessage(inputBoxName: "find" | "replace", skipHiding?: boolean): void {
        const inputBox: HTMLInputElement = inputBoxName === "find" ? this.findTextBox : this.replaceTextBox;
        const errorMessageBox = document.getElementById(`${inputBoxName}-message-box`) as HTMLDivElement;
        // Add the classes for proper styling of the message
        inputBox.classList.remove("error-border", "warning-border");
        errorMessageBox.classList.remove("error-border", "warning-border", "input-warning", "input-error");
        if (skipHiding !== true) errorMessageBox.hidden = true;
    }
}
