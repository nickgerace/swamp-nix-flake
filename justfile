model := "nix-flake"

metadata:
    swamp model method run {{model}} metadata

show:
    swamp model method run {{model}} show

check:
    swamp model method run {{model}} check

update:
    swamp model method run {{model}} update

build attr="default":
    swamp model method run {{model}} build --input outputAttr={{attr}}
