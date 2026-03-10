var input = document.querySelectorAll(".phone-valid"),
    fullPhone = document.querySelectorAll(".full_phone");

const iti = [];
for (var i = 0; i < input.length; i++){
iti[i] = .intlTelInput(input[i], {
    nationalMode: true,
    separateDialCode: true,
    excludeCountries: ["ua"],
    initialCountry: "auto",
    geoIpLookup: function (callback) {
        $.get("https://ipwhois.pro/?key=gqbTeyR1EXgeEFyi", function () { }, "jsonp").always(function (resp) {
             var countryCode = resp.country_code ? resp.country_code : "us";
             callback(countryCode);
        });
     },
    utilsScript: "build/js/utils.js?1638200991544" // just for formatting/placeholders etc
});
}




var handleChange = function (num) {
    var text = (iti[num].isValidNumber()) ? iti[num].getNumber() : "Please enter a number below";
    var textNode = document.createTextNode(text);
    fullPhone[num].value = (iti[num].isValidNumber()) ? iti[num].getNumber() : "z";
};

// listen to "keyup", but also "change" to update when the user selects a country
const flagContainer = document.querySelector('.iti__selected-flag');

document.addEventListener('click', function (event) {

        for (var i = 0; i < input.length; i++) {
            handleChange(i);
        }

})

for (var i = 0; i < input.length; i++) {
    input[i].addEventListener('change', handleChange(i));
}

for (var i = 0; i < input.length; i++) {
    input[i].addEventListener('keyup', handleChange(i));
}


const errorNumber = document.querySelectorAll('.error-number'),
    phoneInput = document.querySelectorAll('.phone-valid');

function errorShow(num) {
    input[num].classList.add('activeBad');
}
function errorHide(num) {
    input[num].classList.remove('activeBad');
        input[num].classList.add('activeGood');
}

    function phoneInputFun(num) {
        (iti[num].isValidNumber()) ? errorHide(num) : errorShow(num);
        phoneInput[num].addEventListener('input', () => {
            (iti[num].isValidNumber()) ? errorHide(num) : errorShow(num);
        })
    }




function selectChecker(num) {
    const flagContainerMain = document.querySelector('.iti__selected-flag');

    document.addEventListener('click', function (event) {
        if (event.target == flagContainerMain.children) {

                handleChange(num);

        }
    })
}
