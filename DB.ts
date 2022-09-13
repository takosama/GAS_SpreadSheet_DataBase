class DB {
    book = SpreadsheetApp.getActiveSpreadsheet();
    sheet: GoogleAppsScript.Spreadsheet.Sheet | null = null;
    private data: any[][] = [];
    private labels: string[] = [];
    id: number = -1;
    log: string = "";
    name: string = "";

    Connect(name: string): boolean {
        this.sheet = this.book.getSheetByName(name);
        this.name = name;
        if (this.sheet == null)
            return false;
        this.labels = this.sheet?.getRange(2, 1, 1, this.sheet.getLastColumn()).getValues()[0];

        if (this.sheet.getLastRow() - 2 <= 0)
            this.data = [];
        else
            this.data = this.sheet.getRange(3, 1, this.sheet.getLastRow() - 2, this.sheet.getLastColumn()).getValues();

        this.id = Number(this.sheet?.getRange(1, 1).getValue());

        this.log += "$Connected :\n\t" + name + "\n\n";
        return true;
    }

    Result(): { [label: string]: any; }[] {
        let rtn: { [label: string]: any; }[] = [];
        for (let i = 0; i < this.data.length; i++) {
            var tmp: { [index: string]: any; } = [];
            for (let j = 0; j < this.data[i].length; j++) {
                tmp[this.labels[j]] = (this.data[i][j]);
            }
            rtn.push(tmp);
        }

        let insstr = "";
        for (const key in rtn) {
            const value = rtn[key];
            insstr += key + ":" + value + " ";
        }

        this.log += "$Result\n" +
            "lines :\n\t" + rtn.length + "\n" +
            "result :\n\t" + insstr.substring(0, 20) + "\n\n";
        return rtn;
    }


    Map(func: (dic: { [label: string]: any; }, id: string) => { [label: string]: any; }, labels: (labels: string[]) => string[]): this {
        let str = "";
        let data2: any[][] = [];
        let labels2 = labels(this.labels.slice(1));
        for (let i = 0; i < this.data.length; i++) {
            var tmp: { [index: string]: any; } = [];
            var tmp2: any[] = [];
            for (let j = 1; j < this.data[i].length; j++) {
                tmp[this.labels[j]] = (this.data[i][j]);
                str += this.labels[j] + "=" + this.data[i][j] + " ";
            }
            str += "\n";

            tmp2[0] = this.data[i][0];
            let val = func(tmp, tmp2[0]);
            str += "\n" + JSON.stringify(val) + "\n";
            str += "0" + "=" + this.data[i][0] + " ";

            for (let j = 0; j < labels2.length; j++) {
                tmp2[j + 1] = val[labels2[j]];
                str += labels2[j] + "=" + val[labels2[j]] + " ";

            }
            data2.push(tmp2);
        }

        this.labels = ["id"];
        for (let i = 0; i < labels2.length; i++)
            this.labels.push(labels2[i]);

        this.data = data2;

        this.log += "$Map\n" +
            "lines :\n\t" + this.data.length + "\n" +
            "labels :\n\t" + JSON.stringify(this.labels) + "\n" +
            "db state :\n\t" + JSON.stringify(this.data).substring(0, 100) + "\n";
        return this;
    }

    View(): string | null {
        var rtn = this.labels.map(x => String(x)).join("\t") + "\n";
        for (let i = 0; i < this.data.length; i++) {
            rtn += this.data[i].join("\t") + "\n";
        }
        return rtn;
    }

    Filter(func: (dic: { [label: string]: any; }) => boolean): this {
        if (this.sheet == null)
            return this;

        let data2: any[][] = [];
        for (let i = 0; i < this.data.length; i++) {
            var tmp: { [index: string]: any; } = [];
            for (let j = 0; j < this.data[i].length; j++) {
                tmp[this.labels[j]] = (this.data[i][j]);
            }
            if (func(tmp) == true)
                data2.push(this.data[i]);
        }

        this.data = data2;

        this.log += "$Filter\n" +
            "lines :\n\t" + this.data.length + "\n" +
            "db state :\n\t" + JSON.stringify(this.data).substring(0, 20) + "\n\n";
        return this;
    }

    Save() {
        this.sheet?.clear();
        this.sheet?.getRange(1, 1).setValue(this.id);
        this.sheet?.appendRow(this.labels.map(x => x));

        this.sheet?.getRange(3, 1, this.data.length, this.labels.length)
            .setValues(
                this.data.map(x => x.map(y => y))
            );

        this.log += "$Save :\n\t" + this.name + "\n" +
            "lines :\n\t" + this.data.length + "\n" +
            "db state :\n\t" + JSON.stringify(this.data).substring(0, 20) + "\n\n";
    }

    Insert(ins: { [label: string]: any; }) {
        let tmp: any[] = [];

        tmp[0] = (++this.id);
        for (let i = 1; i < this.labels.length; i++) {
            tmp[i] = ins[this.labels[i]];
        }
        this.data.push(tmp);

        let insstr = "";
        for (const key in ins) {
            const value = ins[key];
            insstr += key + ":" + value + " ";
        }

        this.log +=
            "$Insert\n"
            + "data :\n\t" +
            insstr.substring(0, 20) + "\n" +
            "lines :\n\t" + this.data.length + "\n" +
            "db state :\n\t" + JSON.stringify(this.data).substring(0, 20) + "\n\n";
    }

    Create(name: string, labels: string[]) {
        this.sheet = this.book.insertSheet().setName(name);
        this.sheet.getRange(1, 1, 1, 1).setValue(0);
        this.sheet.getRange(2, 1).setValue("id");
        this.sheet.getRange(2, 2, 1, labels.length).setValues([labels]);

        this.log += "$Create :\n\t" + name + "\n" +
            "labels :\n\t" + JSON.stringify(labels) + "\n";
    }
}
