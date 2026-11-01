import nonce from "@/common/nonce";

export class SourceViewModel {
  Id: string = "";
  Name: string = "";
  Url: string = "";
  PasswordScriptPath: string = "";
  DraftName: string = "";
  DraftUrl: string = "";
  DraftPasswordScriptPath: string = "";
  EditMode: boolean = false;
  Editable: boolean = true;

  constructor(model: Source | null = null) {
    this.Id = nonce();
    this.Name = model?.Name ?? "";
    this.Url = model?.Url ?? "";
    this.PasswordScriptPath = model?.PasswordScriptPath ?? "";
  }

  Edit() {
    this.DraftName = this.Name;
    this.DraftUrl = this.Url;
    this.DraftPasswordScriptPath = this.PasswordScriptPath;
    this.EditMode = true;
  }
  Cancel() {
    this.EditMode = false;
  }
  Save() {
    this.Name = this.DraftName;
    this.Url = this.DraftUrl;
    this.PasswordScriptPath = this.DraftPasswordScriptPath;
    this.EditMode = false;
  }
  GetModel(): Source {
    const model: Source = {
      Name: this.Name,
      Url: this.Url,
    };
    if (this.PasswordScriptPath) {
      model.PasswordScriptPath = this.PasswordScriptPath;
    }
    return model;
  }
}
